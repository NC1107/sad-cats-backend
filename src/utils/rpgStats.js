/**
 * RPG stat derivation — the single source of truth for how a cat card's
 * collection metadata (rarity + fun_stats) plus its level become combat stats.
 *
 * Pure module: no DB, no side effects. The frontend mirrors this exactly in
 * src/lib/catSpecies.js — keep the two in sync when tuning numbers.
 *
 * Numbers boundary: everything here is plain JS Number (hundreds–thousands,
 * never near MAX_SAFE_INTEGER). RPG stats are NEVER break_infinity Decimal and
 * NEVER NUMERIC columns. Only SC rewards cross into the Decimal economy, and
 * only through the existing server-clamped score path (see rpg-rewards.service).
 *
 * All values resolved by the game-dev balance review (see V2_RPG_PLAN.md
 * "Open questions — RESOLVED"). Tuning lives here; docs follow this file.
 */

// Base stats by rarity at level 1, before fun_stats spice. 3× mythic:common gap.
const RARITY_BASES = {
  common:    { hp: 80,  atk: 15, def: 8,  spd: 10, crit: 3 },
  uncommon:  { hp: 100, atk: 19, def: 11, spd: 12, crit: 4.5 },
  rare:      { hp: 130, atk: 24, def: 14, spd: 14, crit: 6 },
  epic:      { hp: 165, atk: 31, def: 18, spd: 17, crit: 8 },
  legendary: { hp: 215, atk: 41, def: 24, spd: 21, crit: 11 },
  mythic:    { hp: 270, atk: 55, def: 34, spd: 26, crit: 14 },
};

// buff_type → combat role + signature special. buff_value scales the special.
const ROLES = {
  click:   { role: 'Striker',    special: 'Pounce — heavy single hit' },
  passive: { role: 'Sustain',    special: 'Purr — heal lowest ally' },
  auto:    { role: 'Skirmisher', special: 'Flurry — two quick hits' },
  boss:    { role: 'Breaker',    special: 'Rend — ignores enemy DEF' },
  all:     { role: 'Support',    special: 'Rally — +party ATK for 2 turns' },
};

// Max level by rarity (multiples of 5 for legibility).
const LEVEL_CAPS = {
  common: 20, uncommon: 25, rare: 30, epic: 35, legendary: 40, mythic: 45,
};

const CRIT_CAP = 40;          // CRIT% hard cap after fun_stats
const STAT_GROWTH = 0.06;     // +6% per level above 1
const STAMINA_BASE_CAP = 100;
const STAMINA_MEMBER_CAP = 120;
const STAMINA_REGEN_MS = 4 * 60 * 1000;   // +1 stamina per 4 minutes

/**
 * Normalize fun_stats, which may arrive as a JSONB object or a JSON string.
 * Missing values default to 0.
 */
function parseFunStats(funStats) {
  let fs = funStats;
  if (typeof fs === 'string') {
    try { fs = JSON.parse(fs); } catch { fs = {}; }
  }
  fs = fs || {};
  return {
    nap: Number(fs.nap) || 0,
    zoom: Number(fs.zoom) || 0,
    chaos: Number(fs.chaos) || 0,
  };
}

/**
 * Base (level-1) combat stats: rarity base + fun_stats spice.
 * @param {string} rarity
 * @param {object|string} funStats  {nap,zoom,chaos}
 */
function computeBaseStats(rarity, funStats) {
  const b = RARITY_BASES[rarity] || RARITY_BASES.common;
  const { nap, zoom, chaos } = parseFunStats(funStats);
  return {
    hp:   b.hp  + nap * 4,
    atk:  b.atk + zoom * 1.5,
    def:  b.def + Math.floor(nap / 2) * 2,
    spd:  b.spd + Math.floor(zoom / 2),
    crit: Math.min(CRIT_CAP, b.crit + chaos * 0.6),
  };
}

function scaleStat(stat1, level) {
  return Math.round(stat1 * (1 + STAT_GROWTH * (level - 1)));
}

/**
 * Fully derived combat stats for a card at a given level.
 * @param {{rarity:string, fun_stats:object|string}} card  cat_cards row
 * @param {number} level
 */
function deriveStats(card, level = 1) {
  const base = computeBaseStats(card.rarity, card.fun_stats);
  return {
    hp:   scaleStat(base.hp, level),
    atk:  scaleStat(base.atk, level),
    def:  scaleStat(base.def, level),
    spd:  scaleStat(base.spd, level),
    crit: Math.round(base.crit), // CRIT% does not scale with level
  };
}

/** XP required to advance FROM `level` to `level + 1`. */
function xpToNext(level) {
  return Math.floor(50 * Math.pow(level, 1.6));
}

/** Cumulative XP needed to go from level 1 to `targetLevel`. */
function cumulativeXpToReach(targetLevel) {
  let total = 0;
  for (let l = 1; l < targetLevel; l++) total += xpToNext(l);
  return total;
}

/**
 * Convert an absolute XP total (earned from level 1) into {level, xp}, where
 * `xp` is the remainder within the current level. Respects the rarity cap:
 * a capped cat keeps level = cap and xp = 0.
 * @param {number} totalXp
 * @param {number} cap  level cap for this cat's rarity
 */
function resolveLevelFromTotalXp(totalXp, cap) {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (level < cap) {
    const need = xpToNext(level);
    if (remaining < need) break;
    remaining -= need;
    level += 1;
  }
  return { level, xp: level >= cap ? 0 : remaining };
}

function levelCap(rarity) {
  return LEVEL_CAPS[rarity] || LEVEL_CAPS.common;
}

// ---- Combat stakes (see COMBAT_STAKES_V1.md) ----
const DOWN_REST_PER_MIN = 30;      // rest minutes per lifetime down
const DOWN_REST_CAP_MIN = 180;     // hard cap on the natural-rest timer
const MAX_LEVEL_REDUCTION_CAP = 5; // most a cat can lose from the confidence penalty
const LEVEL_REDUCTION_FLOOR = 10;  // reduced cap never drops below this

/** Natural-rest minutes for a downed cat: lifetimeDowns × 30, capped at 180. */
function restMinutesForDowns(lifetimeDowns) {
  return Math.min(DOWN_REST_CAP_MIN, Math.max(1, lifetimeDowns) * DOWN_REST_PER_MIN);
}

/** Catnip cost to instantly revive: min(120, 20 + 20 × lifetimeDowns). */
function reviveCost(lifetimeDowns) {
  return Math.min(120, 20 + 20 * Math.max(1, lifetimeDowns));
}

/** Catnip cost of a Confidence Treat (+1 max level): 100 × (restores + 1). */
function confidenceTreatCost(restores) {
  return 100 * ((restores || 0) + 1);
}

/**
 * A cat's effective level cap after the confidence penalty. Never below the
 * cat's current level (earned levels are never lost) or a hard floor of 10.
 */
function effectiveLevelCap(rarity, reduction = 0, currentLevel = 1) {
  return Math.max(LEVEL_REDUCTION_FLOOR, currentLevel, levelCap(rarity) - (reduction || 0));
}

function roleFor(buffType) {
  return ROLES[buffType] || ROLES.all;
}

function staminaCap(isMember) {
  return isMember ? STAMINA_MEMBER_CAP : STAMINA_BASE_CAP;
}

/**
 * Lazy stamina regen: compute current stamina from the stored value + elapsed
 * time since stamina_updated_at, capped. Pure — caller decides when to persist.
 * @returns {{stamina:number, regenerated:number}}
 */
function regenStamina(stored, staminaUpdatedAt, isMember, now = Date.now()) {
  const cap = staminaCap(isMember);
  if (stored >= cap) return { stamina: cap, regenerated: 0 };
  const elapsed = now - new Date(staminaUpdatedAt).getTime();
  const gained = Math.max(0, Math.floor(elapsed / STAMINA_REGEN_MS));
  const stamina = Math.min(cap, stored + gained);
  return { stamina, regenerated: stamina - stored };
}

/** rosterBonus idle multiplier from total cat levels: 1 + min(0.30, total/800). */
function rosterBonus(totalCatLevels) {
  return 1 + Math.min(0.30, (totalCatLevels || 0) / 800);
}

module.exports = {
  RARITY_BASES,
  ROLES,
  LEVEL_CAPS,
  CRIT_CAP,
  STAT_GROWTH,
  STAMINA_REGEN_MS,
  parseFunStats,
  computeBaseStats,
  scaleStat,
  deriveStats,
  xpToNext,
  cumulativeXpToReach,
  resolveLevelFromTotalXp,
  levelCap,
  effectiveLevelCap,
  restMinutesForDowns,
  reviveCost,
  confidenceTreatCost,
  MAX_LEVEL_REDUCTION_CAP,
  LEVEL_REDUCTION_FLOOR,
  roleFor,
  staminaCap,
  regenStamina,
  rosterBonus,
};

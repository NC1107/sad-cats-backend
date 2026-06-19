// Anti-cheat validation service. Phase 1 of the anti-cheat plan
// (see ANTI_CHEAT_PLAN.md). Read-only signal compute + a recordAnomaly fn that
// writes to the new score_anomalies table.
//
// Design mirrors services/trust.service.js: pure functions for the math, one
// fn that touches the DB. Controllers call the math, decide what to do
// (clamp/reject/persist), then call recordAnomaly when something fishy
// happens.
//
// Nothing in this file rejects requests — that's the controller's job. Phase 1
// records signal without changing behavior; Phase 3 flips hard rows to 422.

const pool = require('../config/database');
const logger = require('../utils/logger');

// Generous headroom multiplier on the theoretical max earnings — covers stacked
// frenzy/cosmic/boss buffs that we don't simulate server-side. Bumping this
// shrinks false positives at the cost of letting more soft cheating through;
// 10× was the pre-extraction inline value. Phase 2 soak will retune.
const SOFT_CAP_HEADROOM = 10;

// Max sustained human click rate — same threshold as the per-request cps hard-reject.
// Used so computeMaxDelta accounts for manual-click income (otherwise a click-heavy
// build's legitimate delta would exceed the ceiling).
const MAX_HUMAN_CPS = 17;

// Backstops — every monotonicity rule includes a hard ceiling so a single
// escaped rule can't let a value explode arbitrarily.
const MAX_PRESTIGE_LEVEL = 10_000;
const MAX_ASCENSION_LEVEL = 1_000;

// Boss-damage clamp. Boss damage is dealt ONLY by active clicks, so the damage a
// player reports in a sync window cannot massively exceed the SCORE they earned in
// that same window — both derive from click power. We clamp `clickDamage` to a
// generous multiple of the request's score delta, with an absolute floor so an
// early player (tiny delta but legitimate clicks) is never clamped. This kills the
// "clickDamage: 1e12 → instantly defeat the community boss" exploit without a
// server-side income-formula mirror or any new persisted field. Tune from soak data.
const CLICK_DAMAGE_FLOOR = 1_000_000;
const CLICK_DAMAGE_MULT = 20;

/**
 * Maximum plausible boss click-damage for a sync carrying score `delta`.
 * @param {number} delta  the score delta reported in the same request
 * @returns {number}      ceiling for clickDamage
 */
function computeMaxClickDamage(delta) {
  const d = Math.abs(Number(delta) || 0);
  return Math.max(CLICK_DAMAGE_FLOOR, d * CLICK_DAMAGE_MULT);
}

/**
 * Compute the theoretical maximum delta a player could legitimately earn in
 * `elapsedSec` seconds, given their cached game state.
 *
 * Reads only cached values from `gs` (catsPerSecond, prestigeMultiplier, etc.)
 * — does NOT recompute from raw upgrades. That mirror is deferred to Phase 4+
 * unless soak data shows cached-value cheating.
 *
 * @param {object} gs           Cached game state from the DB row
 * @param {number} elapsedSec   Seconds since the player's last sync
 * @returns {number}            Soft-cap ceiling for the requested delta
 */
function computeMaxDelta(gs, elapsedSec) {
  if (!gs || elapsedSec <= 0) return 0;
  const cps = Number(gs.catsPerSecond) || 0;
  const cpsMult = Number(gs.cpsMultiplier) || 1;
  const prestigeMult = Number(gs.prestigeMultiplier) || 1;
  const ascMult = Number(gs.ascensionMultiplier) || 1;
  const autoClicks = Number(gs.autoClicksPerSecond) || 0;
  const clickPower = Number(gs.clickPower) || 1;
  const clickMult = Number(gs.clickMultiplier) || 1;

  const passive = cps * cpsMult * prestigeMult * ascMult;
  const auto = autoClicks * clickPower * clickMult * prestigeMult * ascMult;
  // Manual clicks: bounded by the max human click rate. Critical to include — for a
  // click-heavy build this dwarfs passive/auto income, and without it a legitimate
  // delta would blow past the ceiling (and a future clamp would eat real progress).
  const manual = MAX_HUMAN_CPS * clickPower * clickMult * prestigeMult * ascMult;
  const perSec = passive + auto + manual;
  if (perSec <= 0) return 0;

  return perSec * elapsedSec * SOFT_CAP_HEADROOM;
}

/**
 * Compare two game states and return any monotonicity violations.
 *
 * Rules (each violation gets a row in score_anomalies):
 *
 * | Field            | Allowed                                                    |
 * |------------------|------------------------------------------------------------|
 * | prestigeLevel    | == prev OR == prev+1                                       |
 * | ascensionLevel   | == prev OR (== prev+1 AND next prestige reset to 0)        |
 * | lifetimeEarnings | non-decreasing                                             |
 * | cycleEarnings    | non-decreasing UNLESS prestige grew (then any value OK)    |
 * | bossesDefeated   | non-decreasing                                             |
 * | starShards       | non-decreasing UNLESS prestige grew (shards can drop after |
 * |                  | a respec on the new prestige boundary)                     |
 * | upgrades[id]     | non-decreasing per id                                      |
 * | prestigeLevel    | <= MAX_PRESTIGE_LEVEL hard ceiling                         |
 * | ascensionLevel   | <= MAX_ASCENSION_LEVEL hard ceiling                        |
 *
 * Affordability (whether the player could actually pay for new upgrades since
 * last save) is NOT checked in Phase 1 — that needs a per-upgrade cost calc
 * that mirrors gameConstants.js. Deferred unless Phase 2 soak data shows
 * cached-value cheating.
 *
 * @param {object} prev   Persisted game_state JSONB from the row
 * @param {object} next   Incoming body.gameState from the client
 * @returns {{ violations: Array<{kind: string, payload: object, severity: string}> }}
 */
function validateMonotonicity(prev, next) {
  const violations = [];
  if (!prev || !next) return { violations };

  const num = (v) => Number(v) || 0;
  const prevPrestige = num(prev.prestigeLevel);
  const nextPrestige = num(next.prestigeLevel);
  const prevAscension = num(prev.ascensionLevel);
  const nextAscension = num(next.ascensionLevel);
  const prestigeGrew = nextPrestige > prevPrestige;

  // --- prestigeLevel: +1 per save, or equal
  if (nextPrestige !== prevPrestige && nextPrestige !== prevPrestige + 1) {
    violations.push({
      kind: 'monotonicity_prestigeLevel',
      severity: nextPrestige > prevPrestige + 1 ? 'hard' : 'soft',
      payload: { prev: prevPrestige, next: nextPrestige },
    });
  }
  if (nextPrestige > MAX_PRESTIGE_LEVEL) {
    violations.push({
      kind: 'monotonicity_prestigeLevel_ceiling',
      severity: 'hard',
      payload: { value: nextPrestige, ceiling: MAX_PRESTIGE_LEVEL },
    });
  }

  // --- ascensionLevel: only +1, and only when prestige resets to 0
  if (nextAscension !== prevAscension) {
    const validJump = nextAscension === prevAscension + 1 && nextPrestige === 0;
    if (!validJump) {
      violations.push({
        kind: 'monotonicity_ascensionLevel',
        severity: nextAscension > prevAscension + 1 ? 'hard' : 'soft',
        payload: { prev: prevAscension, next: nextAscension, nextPrestige },
      });
    }
  }
  if (nextAscension > MAX_ASCENSION_LEVEL) {
    violations.push({
      kind: 'monotonicity_ascensionLevel_ceiling',
      severity: 'hard',
      payload: { value: nextAscension, ceiling: MAX_ASCENSION_LEVEL },
    });
  }

  // --- lifetimeEarnings: strictly non-decreasing. Number() loses precision past
  //     ~9e15 but the comparison is fine for ordering at any magnitude pg returns.
  if (num(next.lifetimeEarnings) < num(prev.lifetimeEarnings)) {
    violations.push({
      kind: 'monotonicity_lifetimeEarnings',
      severity: 'hard',
      payload: { prev: String(prev.lifetimeEarnings), next: String(next.lifetimeEarnings) },
    });
  }

  // --- cycleEarnings: non-decreasing unless prestige grew (cycle resets on prestige)
  if (!prestigeGrew && num(next.cycleEarnings) < num(prev.cycleEarnings)) {
    violations.push({
      kind: 'monotonicity_cycleEarnings',
      severity: 'hard',
      payload: { prev: String(prev.cycleEarnings), next: String(next.cycleEarnings) },
    });
  }

  // --- bossesDefeated: non-decreasing
  if (num(next.bossesDefeated) < num(prev.bossesDefeated)) {
    violations.push({
      kind: 'monotonicity_bossesDefeated',
      severity: 'hard',
      payload: { prev: num(prev.bossesDefeated), next: num(next.bossesDefeated) },
    });
  }

  // --- starShards: non-decreasing unless prestige grew (respec on the new
  //     prestige boundary can drop the count).
  if (!prestigeGrew && num(next.starShards) < num(prev.starShards)) {
    violations.push({
      kind: 'monotonicity_starShards',
      severity: 'hard',
      payload: { prev: num(prev.starShards), next: num(next.starShards) },
    });
  }

  // --- prestigeMultiplier / ascensionMultiplier: permanent cumulative bonuses that
  //     only ever grow. A real decrease signals a forged/rolled-back state. Soft,
  //     because a client recalc can dip by a rounding hair; the 0.1% tolerance avoids
  //     float false-positives. (These fields ARE persisted, unlike catsPerSecond/
  //     clickPower — see the computeMaxDelta note.)
  const prevPMult = num(prev.prestigeMultiplier) || 1;
  const nextPMult = num(next.prestigeMultiplier) || 1;
  if (next.prestigeMultiplier !== undefined && nextPMult < prevPMult * 0.999) {
    violations.push({
      kind: 'monotonicity_prestigeMultiplier',
      severity: 'soft',
      payload: { prev: prevPMult, next: nextPMult },
    });
  }
  const prevAMult = num(prev.ascensionMultiplier) || 1;
  const nextAMult = num(next.ascensionMultiplier) || 1;
  if (next.ascensionMultiplier !== undefined && nextAMult < prevAMult * 0.999) {
    violations.push({
      kind: 'monotonicity_ascensionMultiplier',
      severity: 'soft',
      payload: { prev: prevAMult, next: nextAMult },
    });
  }

  // --- upgrades[id]: each count non-decreasing
  const prevUpgrades = prev.upgrades || {};
  const nextUpgrades = next.upgrades || {};
  for (const id of Object.keys(prevUpgrades)) {
    const pv = num(prevUpgrades[id]);
    const nv = num(nextUpgrades[id]);
    if (nv < pv) {
      violations.push({
        kind: 'monotonicity_upgrade',
        severity: 'hard',
        payload: { id, prev: pv, next: nv },
      });
    }
  }

  return { violations };
}

/**
 * Persist an anomaly record. Soft path (logger.warn for grep), hard path
 * (logger.error). Always returns void — failure to write the anomaly must not
 * fail the request that triggered it.
 *
 * @param {string} discordId
 * @param {string} kind        canonical kind string ('delta_clamped', 'monotonicity_*', 'cps_rejected', ...)
 * @param {object} [meta]
 * @param {number} [meta.delta]
 * @param {number} [meta.maxDelta]
 * @param {number} [meta.elapsedSec]
 * @param {string} [meta.severity='soft']
 * @param {object} [meta.payload]
 */
async function recordAnomaly(discordId, kind, meta = {}) {
  const { delta = null, maxDelta = null, elapsedSec = null, severity = 'soft', payload = {} } = meta;
  const logLevel = severity === 'hard' ? 'error' : 'warn';
  logger[logLevel]('score_anomaly', { discordId, kind, delta, maxDelta, elapsedSec, severity, payload });

  try {
    await pool.query(
      `INSERT INTO score_anomalies (discord_id, kind, delta, max_delta, elapsed_sec, severity, payload)
       VALUES ($1, $2, $3::NUMERIC, $4::NUMERIC, $5, $6, $7::JSONB)`,
      [
        discordId,
        kind,
        delta != null ? String(delta) : null,
        maxDelta != null ? String(maxDelta) : null,
        elapsedSec,
        severity,
        JSON.stringify(payload),
      ]
    );
  } catch (e) {
    // Non-blocking — better to drop one anomaly row than 500 a legitimate sync.
    logger.error('Failed to persist score_anomaly', { error: e.message, discordId, kind });
  }
}

module.exports = {
  SOFT_CAP_HEADROOM,
  MAX_HUMAN_CPS,
  MAX_PRESTIGE_LEVEL,
  MAX_ASCENSION_LEVEL,
  CLICK_DAMAGE_FLOOR,
  CLICK_DAMAGE_MULT,
  computeMaxDelta,
  computeMaxClickDamage,
  validateMonotonicity,
  recordAnomaly,
};

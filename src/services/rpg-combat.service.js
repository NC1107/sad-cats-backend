/**
 * Server-authoritative turn-based combat resolution.
 *
 * The client sends only intent (encounter + party ids); the server resolves the
 * entire fight here and returns a summary + a playback log (the log has no
 * authority — it's for client animation only). Deterministic given a `seed`, so
 * any fight can be re-derived and audited from the stored party snapshot.
 *
 * Pure module: takes plain combatant objects, returns a result. No DB, no time.
 */

// mulberry32 — small, fast, deterministic PRNG seeded from a 32-bit integer.
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_TURNS = 60;          // hard stop; exceeding = loss (stall protection)
const FOCUS_START = 1;
const FOCUS_MAX = 3;
const SPECIAL_COST = 2;
const LOW_HP_HEAL_THRESHOLD = 0.6;

// Make a mutable battle actor from a combatant descriptor.
function toActor(c, side, index) {
  const maxHp = Math.max(1, Math.round(c.stats.hp));
  return {
    side,                 // 'party' | 'enemy'
    index,
    id: c.playerCardId || `${side}_${index}`,
    name: c.name || c.catName || 'Cat',
    spriteId: c.cardId || null,   // card id for the party sprite; null for enemies
    role: c.role || 'Striker',
    buffValue: Number(c.buffValue) || 0,
    atk: Math.round(c.stats.atk),
    def: Math.round(c.stats.def),
    spd: Math.round(c.stats.spd),
    crit: Number(c.stats.crit) || 0,
    maxHp,
    hp: maxHp,
    focus: FOCUS_START,
    atkBuffTurns: 0,        // Rally: +25% atk while > 0
  };
}

function alive(a) { return a.hp > 0; }

function effectiveAtk(actor) {
  return actor.atkBuffTurns > 0 ? actor.atk * 1.25 : actor.atk;
}

function computeDamage(attacker, target, abilityMult, ignoreDef, crit) {
  const defTerm = ignoreDef ? 1 : 100 / (100 + target.def);
  const raw = effectiveAtk(attacker) * abilityMult * (crit ? 1.5 : 1) * defTerm;
  return Math.max(1, Math.round(raw));
}

// Lowest-HP living target on the opposing side.
function pickTarget(actor, actors) {
  const foes = actors.filter(a => a.side !== actor.side && alive(a));
  if (!foes.length) return null;
  return foes.reduce((lo, a) => (a.hp < lo.hp ? a : lo), foes[0]);
}

// Lowest-HP-fraction living ally (including self).
function pickWoundedAlly(actor, actors) {
  const allies = actors.filter(a => a.side === actor.side && alive(a));
  return allies.reduce((lo, a) => (a.hp / a.maxHp < lo.hp / lo.maxHp ? a : lo), allies[0]);
}

/**
 * Resolve a full battle.
 * @param {object[]} party    party combatants (with playerCardId, role, buffValue, stats)
 * @param {object[]} enemies  enemy combatants
 * @param {number}   seed     deterministic seed
 * @returns {{result:'win'|'loss', turns:number, log:object[], survivors:string[]}}
 */
function simulateBattle(party, enemies, seed) {
  const rng = makeRng(seed);
  const actors = [
    ...party.map((c, i) => toActor(c, 'party', i)),
    ...enemies.map((c, i) => toActor(c, 'enemy', i)),
  ];
  const log = [];
  const emit = (text, extra) => log.push({ turn: turns, text, ...extra });

  const partyAlive = () => actors.some(a => a.side === 'party' && alive(a));
  const enemyAlive = () => actors.some(a => a.side === 'enemy' && alive(a));

  let turns = 0;
  // Initiative: highest SPD first; stable tiebreak by side (party before enemy) then index.
  const order = actors.slice().sort((a, b) =>
    b.spd - a.spd || (a.side === b.side ? a.index - b.index : a.side === 'party' ? -1 : 1)
  );

  while (turns < MAX_TURNS && partyAlive() && enemyAlive()) {
    turns += 1;
    for (const actor of order) {
      if (!alive(actor)) continue;
      if (!partyAlive() || !enemyAlive()) break;

      // Tick down Rally buff at the start of this actor's turn.
      if (actor.atkBuffTurns > 0) actor.atkBuffTurns -= 1;
      actor.focus = Math.min(FOCUS_MAX, actor.focus + 1);

      takeTurn(actor, actors, rng, emit);
    }
  }

  const result = enemyAlive() ? 'loss' : 'win';
  const survivors = actors
    .filter(a => a.side === 'party' && alive(a))
    .map(a => a.id);

  // Roster for client-side playback (maxHp is unchanged by the sim; the client
  // replays the log to drain HP from these starting values).
  const combatants = actors.map(a => ({
    id: a.id,
    name: a.name,
    side: a.side,
    role: a.role,
    spriteId: a.spriteId,
    maxHp: a.maxHp,
  }));

  return { result, turns, log, survivors, combatants };
}

function takeTurn(actor, actors, rng, emit) {
  const role = actor.role;
  const canSpecial = actor.focus >= SPECIAL_COST;

  // Sustain heals when an ally is hurt and focus allows.
  if (role === 'Sustain' && canSpecial) {
    const wounded = pickWoundedAlly(actor, actors);
    if (wounded && wounded.hp / wounded.maxHp < LOW_HP_HEAL_THRESHOLD) {
      const heal = Math.round(20 + actor.buffValue * 200);
      wounded.hp = Math.min(wounded.maxHp, wounded.hp + heal);
      actor.focus -= SPECIAL_COST;
      emit(`${actor.name} purrs, healing ${wounded.name} for ${heal}`, { type: 'heal', actorId: actor.id, targetId: wounded.id, heal });
      return;
    }
  }

  // Support buffs the party's attack when focus allows.
  if (role === 'Support' && canSpecial) {
    actors.filter(a => a.side === actor.side && alive(a)).forEach(a => { a.atkBuffTurns = 2; });
    actor.focus -= SPECIAL_COST;
    emit(`${actor.name} rallies the party (+25% ATK, 2 turns)`, { type: 'buff', actorId: actor.id });
    return;
  }

  const target = pickTarget(actor, actors);
  if (!target) return;

  // Offensive specials.
  if (canSpecial && role === 'Striker') {
    const mult = 1.5 + actor.buffValue * 10;
    const crit = rng() < actor.crit / 100;
    const dmg = computeDamage(actor, target, mult, false, crit);
    target.hp -= dmg;
    actor.focus -= SPECIAL_COST;
    emit(`${actor.name} pounces ${target.name} for ${dmg}${crit ? ' (CRIT)' : ''}`, { type: 'special', dmg, targetId: target.id, actorId: actor.id });
    return;
  }
  if (canSpecial && role === 'Skirmisher') {
    actor.focus -= SPECIAL_COST;
    for (let h = 0; h < 2 && alive(target); h++) {
      const crit = rng() < actor.crit / 100;
      const dmg = computeDamage(actor, target, 0.7, false, crit);
      target.hp -= dmg;
      emit(`${actor.name} flurries ${target.name} for ${dmg}${crit ? ' (CRIT)' : ''}`, { type: 'special', dmg, targetId: target.id, actorId: actor.id });
    }
    return;
  }
  if (canSpecial && role === 'Breaker') {
    const crit = rng() < actor.crit / 100;
    const dmg = computeDamage(actor, target, 1, true, crit); // ignores DEF
    target.hp -= dmg;
    actor.focus -= SPECIAL_COST;
    emit(`${actor.name} rends ${target.name} for ${dmg}${crit ? ' (CRIT)' : ''}`, { type: 'special', dmg, targetId: target.id, actorId: actor.id });
    return;
  }

  // Basic attack.
  const crit = rng() < actor.crit / 100;
  const dmg = computeDamage(actor, target, 1, false, crit);
  target.hp -= dmg;
  emit(`${actor.name} hits ${target.name} for ${dmg}${crit ? ' (CRIT)' : ''}`, { type: 'attack', dmg, targetId: target.id, actorId: actor.id });
}

module.exports = {
  simulateBattle,
  makeRng,
  MAX_TURNS,
};

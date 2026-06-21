const rpgStats = require('../src/utils/rpgStats');

describe('rpgStats.deriveStats', () => {
  test('level-1 common with zero fun_stats equals the rarity base', () => {
    const card = { rarity: 'common', fun_stats: { nap: 0, zoom: 0, chaos: 0 } };
    expect(rpgStats.deriveStats(card, 1)).toEqual({ hp: 80, atk: 15, def: 8, spd: 10, crit: 3 });
  });

  test('fun_stats spice is applied per the documented formula', () => {
    const card = { rarity: 'common', fun_stats: { nap: 10, zoom: 10, chaos: 10 } };
    const s = rpgStats.deriveStats(card, 1);
    // hp 80+40, atk 15+15, def 8+(5*2), spd 10+5, crit min(40, 3+6)
    expect(s).toEqual({ hp: 120, atk: 30, def: 18, spd: 15, crit: 9 });
  });

  test('fun_stats accepts a JSON string (JSONB-from-string path)', () => {
    const card = { rarity: 'rare', fun_stats: '{"nap":4,"zoom":8,"chaos":5}' };
    const s = rpgStats.deriveStats(card, 1);
    expect(s.hp).toBe(130 + 16);
    expect(s.atk).toBe(Math.round(24 + 12));
  });

  test('CRIT% is capped at 40 and does not scale with level', () => {
    const card = { rarity: 'mythic', fun_stats: { nap: 10, zoom: 10, chaos: 10 } };
    // base crit 14 + 6 = 20, well under cap; stays flat across levels
    expect(rpgStats.deriveStats(card, 1).crit).toBe(20);
    expect(rpgStats.deriveStats(card, 45).crit).toBe(20);
  });

  test('+6%/level scaling rounds correctly', () => {
    const card = { rarity: 'common', fun_stats: { nap: 0, zoom: 0, chaos: 0 } };
    // hp 80 * (1 + 0.06*19) = 80 * 2.14 = 171.2 -> 171
    expect(rpgStats.deriveStats(card, 20).hp).toBe(171);
  });
});

describe('rpgStats.xpToNext / level resolution', () => {
  test('xpToNext follows floor(50 * L^1.6)', () => {
    expect(rpgStats.xpToNext(1)).toBe(50);
    expect(rpgStats.xpToNext(2)).toBe(Math.floor(50 * Math.pow(2, 1.6)));
    expect(rpgStats.xpToNext(10)).toBe(Math.floor(50 * Math.pow(10, 1.6)));
  });

  test('cumulativeXpToReach sums the per-level costs', () => {
    const expected = rpgStats.xpToNext(1) + rpgStats.xpToNext(2) + rpgStats.xpToNext(3);
    expect(rpgStats.cumulativeXpToReach(4)).toBe(expected);
  });

  test('resolveLevelFromTotalXp converts a total into level + remainder', () => {
    const toL3 = rpgStats.xpToNext(1) + rpgStats.xpToNext(2);
    expect(rpgStats.resolveLevelFromTotalXp(toL3, 20)).toEqual({ level: 3, xp: 0 });
    expect(rpgStats.resolveLevelFromTotalXp(toL3 + 10, 20)).toEqual({ level: 3, xp: 10 });
  });

  test('resolveLevelFromTotalXp respects the rarity cap', () => {
    const huge = 10_000_000;
    expect(rpgStats.resolveLevelFromTotalXp(huge, 20)).toEqual({ level: 20, xp: 0 });
  });
});

describe('rpgStats.rosterBonus', () => {
  test('scales linearly then soft-caps at +30%', () => {
    expect(rpgStats.rosterBonus(0)).toBe(1);
    expect(rpgStats.rosterBonus(150)).toBeCloseTo(1 + 150 / 800, 6);
    expect(rpgStats.rosterBonus(800)).toBe(1.30);
    expect(rpgStats.rosterBonus(5000)).toBe(1.30);
  });
});

describe('rpgStats.regenStamina', () => {
  test('regenerates 1 per 4 minutes, capped at the pool', () => {
    const now = Date.now();
    const eightMinAgo = new Date(now - 8 * 60 * 1000).toISOString();
    expect(rpgStats.regenStamina(50, eightMinAgo, false, now).stamina).toBe(52);
  });

  test('member pool caps higher', () => {
    const now = Date.now();
    const longAgo = new Date(now - 100 * 60 * 60 * 1000).toISOString();
    expect(rpgStats.regenStamina(0, longAgo, false, now).stamina).toBe(100);
    expect(rpgStats.regenStamina(0, longAgo, true, now).stamina).toBe(120);
  });
});

describe('rpgStats combat stakes', () => {
  test('restMinutesForDowns scales by 30/down, capped at 180', () => {
    expect(rpgStats.restMinutesForDowns(1)).toBe(30);
    expect(rpgStats.restMinutesForDowns(3)).toBe(90);
    expect(rpgStats.restMinutesForDowns(6)).toBe(180);
    expect(rpgStats.restMinutesForDowns(50)).toBe(180); // cap
  });

  test('reviveCost = min(120, 20 + 20*lifetimeDowns)', () => {
    expect(rpgStats.reviveCost(1)).toBe(40);
    expect(rpgStats.reviveCost(2)).toBe(60);
    expect(rpgStats.reviveCost(5)).toBe(120);
    expect(rpgStats.reviveCost(99)).toBe(120); // cap
  });

  test('confidenceTreatCost escalates 100 per prior restore', () => {
    expect(rpgStats.confidenceTreatCost(0)).toBe(100);
    expect(rpgStats.confidenceTreatCost(1)).toBe(200);
    expect(rpgStats.confidenceTreatCost(3)).toBe(400);
  });

  test('combatPower is ATK-weighted and additive', () => {
    const weak = rpgStats.combatPower({ hp: 50, atk: 5, def: 2, spd: 5, crit: 0 });
    const strong = rpgStats.combatPower({ hp: 300, atk: 80, def: 40, spd: 30, crit: 15 });
    expect(strong).toBeGreaterThan(weak);
    expect(rpgStats.combatPower(null)).toBe(0);
  });

  test('threatFor maps power ratio to the right tier + confirm gate', () => {
    expect(rpgStats.threatFor(150, 100).tier).toBe('safe');    // 1.5
    expect(rpgStats.threatFor(110, 100).tier).toBe('fair');    // 1.1
    expect(rpgStats.threatFor(80, 100).tier).toBe('risky');    // 0.8
    expect(rpgStats.threatFor(50, 100).tier).toBe('deadly');   // 0.5
    expect(rpgStats.threatFor(50, 100).confirm).toBe('always');
    expect(rpgStats.threatFor(80, 100).confirm).toBe('first');
    expect(rpgStats.threatFor(150, 100).confirm).toBe('never');
    expect(rpgStats.threatFor(100, 0).tier).toBe('safe');      // no enemies → safe
  });

  test('effectiveHp regenerates toward max over 15 min; null = full', () => {
    const now = Date.now()
    expect(rpgStats.effectiveHp(null, null, 200, now)).toBe(200)        // null = full
    expect(rpgStats.effectiveHp(100, null, 200, now)).toBe(100)        // no anchor → as stored
    // half the full-heal window (7.5 min) heals ~50% of max
    const half = new Date(now - rpgStats.FULL_HEAL_MS / 2).toISOString()
    expect(rpgStats.effectiveHp(0, half, 200, now)).toBe(100)
    // past the window → capped at max
    const long = new Date(now - rpgStats.FULL_HEAL_MS * 3).toISOString()
    expect(rpgStats.effectiveHp(50, long, 200, now)).toBe(200)
  })

  test('healCost scales with damage taken, capped at 25, free when full', () => {
    expect(rpgStats.healCost(200, 200)).toBe(0)   // full
    expect(rpgStats.healCost(100, 200)).toBe(13)  // 50% missing → ceil(12.5)
    expect(rpgStats.healCost(0, 200)).toBe(25)    // all missing → cap
  })

  test('effectiveLevelCap subtracts reduction but never below current level or 10', () => {
    // epic base cap 35
    expect(rpgStats.effectiveLevelCap('epic', 0, 1)).toBe(35);
    expect(rpgStats.effectiveLevelCap('epic', 3, 1)).toBe(32);
    // floor at current level: a L34 cat can't be capped below 34
    expect(rpgStats.effectiveLevelCap('epic', 5, 34)).toBe(34);
    // hard floor of 10 for a heavily-reduced low cap
    expect(rpgStats.effectiveLevelCap('common', 5, 1)).toBe(15); // common base 20 - 5
    expect(rpgStats.effectiveLevelCap('common', 20, 1)).toBe(10); // floor
  });
});

describe('rpgStats.roleFor / levelCap', () => {
  test('maps buff_type to role', () => {
    expect(rpgStats.roleFor('click').role).toBe('Striker');
    expect(rpgStats.roleFor('boss').role).toBe('Breaker');
    expect(rpgStats.roleFor('all').role).toBe('Support');
    expect(rpgStats.roleFor('unknown').role).toBe('Support'); // falls back to 'all'
  });

  test('level caps by rarity are multiples of 5', () => {
    expect(rpgStats.levelCap('common')).toBe(20);
    expect(rpgStats.levelCap('mythic')).toBe(45);
  });
});

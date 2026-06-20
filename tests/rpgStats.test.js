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

const dispatch = require('../src/utils/rpgDispatchCatalog');
const daily = require('../src/utils/rpgDailyCatalog');

describe('rpgDispatchCatalog', () => {
  test('exposes 4 escalating tiers with 3 slots', () => {
    expect(dispatch.DISPATCH_SLOTS).toBe(3);
    expect(dispatch.TIERS).toHaveLength(4);
    const durations = dispatch.TIERS.map(t => t.durationMin);
    expect(durations).toEqual([...durations].sort((a, b) => a - b)); // ascending
  });

  test('getTier resolves known tiers and rejects unknown', () => {
    expect(dispatch.getTier('patrol').cats).toBe(1);
    expect(dispatch.getTier('saga').cats).toBe(4);
    expect(dispatch.getTier('nope')).toBeNull();
  });

  test('publicTiers returns a structured stat check (stat/min/label)', () => {
    const tiers = dispatch.publicTiers();
    expect(tiers.find(t => t.id === 'patrol').statCheck).toBeNull();
    expect(tiers.find(t => t.id === 'scout').statCheck).toEqual({ stat: 'spd', min: 40, label: 'Combined SPD ≥ 40' });
    expect(tiers.find(t => t.id === 'expedition').statCheck).toMatchObject({ stat: 'atk', min: 120 });
    expect(tiers.find(t => t.id === 'saga').statCheck).toMatchObject({ stat: 'hp', min: 600 });
  });

  test('higher tiers reward more catnip and xp', () => {
    const c = dispatch.TIERS.map(t => t.catnip);
    const x = dispatch.TIERS.map(t => t.xp);
    expect(c).toEqual([...c].sort((a, b) => a - b));
    expect(x).toEqual([...x].sort((a, b) => a - b));
  });
});

describe('rpgDailyCatalog', () => {
  test('has exactly 3 quests, each with a computable metric', () => {
    expect(daily.DAILY_QUESTS).toHaveLength(3);
    const metrics = daily.DAILY_QUESTS.map(q => q.metric);
    expect(metrics).toEqual(expect.arrayContaining(['wins_today', 'dispatches_today', 'battles_today']));
  });

  test('getQuest resolves and rejects', () => {
    expect(daily.getQuest('win_combats').goal).toBe(3);
    expect(daily.getQuest('__nope__')).toBeNull();
  });

  test('all-done bonus is positive catnip', () => {
    expect(daily.ALL_DONE_BONUS.catnip).toBeGreaterThan(0);
  });
});

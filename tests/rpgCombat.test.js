const { simulateBattle } = require('../src/services/rpg-combat.service');
const storyCatalog = require('../src/utils/rpgStoryCatalog');

function cat(role, stats, id) {
  return { playerCardId: id, name: id, role, buffValue: 0.05, stats };
}
function enemy(stats, name) {
  return { name, role: 'Enemy', buffValue: 0, stats };
}

const STRONG = { hp: 400, atk: 80, def: 40, spd: 30, crit: 10 };
const WEAK = { hp: 50, atk: 5, def: 2, spd: 5, crit: 0 };

describe('rpg-combat.simulateBattle', () => {
  test('is deterministic for a given seed', () => {
    const party = [cat('Striker', STRONG, 'p1'), cat('Sustain', STRONG, 'p2')];
    const enemies = [enemy(WEAK, 'e1'), enemy(WEAK, 'e2')];
    const a = simulateBattle(party, enemies, 12345);
    const b = simulateBattle(party, enemies, 12345);
    expect(a.result).toBe(b.result);
    expect(a.turns).toBe(b.turns);
    expect(a.log).toEqual(b.log);
    expect(a.survivors).toEqual(b.survivors);
  });

  test('different seeds can diverge but always terminate', () => {
    const party = [cat('Striker', { hp: 120, atk: 20, def: 10, spd: 15, crit: 50 }, 'p1')];
    const enemies = [enemy({ hp: 120, atk: 18, def: 10, spd: 14, crit: 50 }, 'e1')];
    for (let seed = 1; seed <= 25; seed++) {
      const r = simulateBattle(party, enemies, seed);
      expect(['win', 'loss']).toContain(r.result);
      expect(r.turns).toBeGreaterThan(0);
      expect(r.turns).toBeLessThanOrEqual(60);
    }
  });

  test('a strong party beats a weak enemy and keeps survivors', () => {
    const party = [cat('Striker', STRONG, 'p1'), cat('Breaker', STRONG, 'p2')];
    const enemies = [enemy(WEAK, 'e1')];
    const r = simulateBattle(party, enemies, 7);
    expect(r.result).toBe('win');
    expect(r.survivors.length).toBeGreaterThan(0);
  });

  test('a hopeless party loses with no survivors', () => {
    const party = [cat('Striker', WEAK, 'p1')];
    const enemies = [enemy(STRONG, 'e1'), enemy(STRONG, 'e2')];
    const r = simulateBattle(party, enemies, 3);
    expect(r.result).toBe('loss');
    expect(r.survivors).toEqual([]);
  });

  test('log entries reference turns and never exceed the cap', () => {
    const party = [cat('Skirmisher', STRONG, 'p1')];
    const enemies = [enemy({ hp: 200, atk: 30, def: 20, spd: 12, crit: 0 }, 'e1')];
    const r = simulateBattle(party, enemies, 99);
    expect(r.log.length).toBeGreaterThan(0);
    for (const entry of r.log) {
      expect(entry.turn).toBeGreaterThanOrEqual(1);
      expect(entry.turn).toBeLessThanOrEqual(60);
    }
  });
});

describe('rpgStoryCatalog', () => {
  test('has 9 chapters x 5 nodes = 45 total', () => {
    expect(storyCatalog.TOTAL_NODES).toBe(45);
    expect(storyCatalog.getStoryMap()).toHaveLength(9);
    expect(storyCatalog.getStoryMap()[0].nodes).toHaveLength(5);
  });

  test('getNode returns enemies and elite reward only on node 5', () => {
    const n1 = storyCatalog.getNode('ch1_n1');
    expect(n1.elite).toBe(false);
    expect(n1.rewardCardId).toBeNull();
    expect(n1.enemies.length).toBeGreaterThan(0);

    const n5 = storyCatalog.getNode('ch1_n5');
    expect(n5.elite).toBe(true);
    expect(n5.rewardCardId).toBe('slate');
  });

  test('nextNodeId walks the chain and ends at the summit', () => {
    expect(storyCatalog.nextNodeId('ch1_n1')).toBe('ch1_n2');
    expect(storyCatalog.nextNodeId('ch1_n5')).toBe('ch2_n1');
    expect(storyCatalog.nextNodeId('ch9_n5')).toBeNull();
  });

  test('rejects malformed node ids', () => {
    expect(storyCatalog.getNode('nope')).toBeNull();
    expect(storyCatalog.getNode('ch10_n1')).toBeNull();
    expect(storyCatalog.getNode('ch1_n6')).toBeNull();
  });

  test('enemy level scales with node depth', () => {
    const early = storyCatalog.getNode('ch1_n1').enemies[0].level;
    const late = storyCatalog.getNode('ch9_n1').enemies[0].level;
    expect(late).toBeGreaterThan(early);
  });
});

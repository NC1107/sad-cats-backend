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

  test('returns a combatants roster with maxHp for both sides (for client playback)', () => {
    const party = [cat('Striker', STRONG, 'p1'), cat('Sustain', STRONG, 'p2')]
    const enemies = [enemy(WEAK, 'e1'), enemy(WEAK, 'e2')]
    const r = simulateBattle(party, enemies, 42)
    expect(r.combatants).toHaveLength(4)
    const p1 = r.combatants.find(c => c.id === 'p1')
    expect(p1).toMatchObject({ side: 'party', maxHp: STRONG.hp })
    expect(r.combatants.filter(c => c.side === 'enemy')).toHaveLength(2)
    // every combatant carries the fields the battle screen needs
    r.combatants.forEach(c => {
      expect(c).toHaveProperty('name')
      expect(c).toHaveProperty('role')
      expect(c.maxHp).toBeGreaterThan(0)
    })
  })

  test('combatants roster exposes startHp so wounded cats show their carried-over HP', () => {
    // p1 carries into the fight at 100/400 HP (attrition); p2 is fresh.
    const wounded = { ...cat('Striker', STRONG, 'p1'), startHp: 100 }
    const fresh = cat('Sustain', STRONG, 'p2')
    const r = simulateBattle([wounded, fresh], [enemy(WEAK, 'e1')], 7)
    const p1 = r.combatants.find(c => c.id === 'p1')
    const p2 = r.combatants.find(c => c.id === 'p2')
    expect(p1).toMatchObject({ maxHp: STRONG.hp, startHp: 100 })          // bar starts at carried-over HP
    expect(p2).toMatchObject({ maxHp: STRONG.hp, startHp: STRONG.hp })    // fresh cat starts full
  })

  test('damage/heal log entries carry actorId + targetId for animation', () => {
    const party = [cat('Striker', STRONG, 'p1')]
    const enemies = [enemy({ hp: 300, atk: 30, def: 15, spd: 12, crit: 0 }, 'e1')]
    const r = simulateBattle(party, enemies, 5)
    const dmg = r.log.find(l => l.type === 'attack' || l.type === 'special')
    expect(dmg.actorId).toBeDefined()
    expect(dmg.targetId).toBeDefined()
    expect(typeof dmg.dmg).toBe('number')
  })

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

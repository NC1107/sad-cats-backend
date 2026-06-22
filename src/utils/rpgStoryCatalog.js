/**
 * Story catalog — "Nine Districts of Sad Cat City".
 *
 * 9 chapters x 5 nodes = 45 linear combat nodes. Clearing a chapter (its 5th /
 * elite node) grants a guaranteed specific card — the non-RNG acquisition path
 * that counters bad case luck. Node ids are `ch{1-9}_n{1-5}`.
 *
 * Code-defined (like BOSS_NAMES / shop tiers); only per-player progress + claims
 * are persisted. Enemy combat stats are generated from node depth so we don't
 * hand-author 45 stat blocks.
 */

// Each district has its own themed enemy pool + a named elite (the chapter's 5th
// node mini-boss). Enemy stats are still generated from depth (see buildEnemy);
// the names only drive flavor + which sprite archetype the frontend draws.
const DISTRICTS = [
  { name: 'The Alley',        reward: 'slate',     enemies: ['Dust Bunny', 'Alley Rat', 'Trash Goblin'],   elite: 'Alpha Stray' },     // uncommon
  { name: 'The Fish Market',  reward: 'specter',   enemies: ['Gull Mob', 'Crab Pincer', 'Fish Thief'],     elite: 'Market Tom' },      // legendary
  { name: 'The Rooftops',     reward: 'blossom',   enemies: ['Pigeon Swarm', 'Antenna Bat', 'Chimney Imp'], elite: 'The Roof Tom' },    // rare
  { name: 'The Docks',        reward: 'midas',     enemies: ['Dock Rat', 'Barnacle Brute', 'Cargo Golem'], elite: 'Harbor Kraken' },   // legendary
  { name: 'The Cannery',      reward: 'cartridge', enemies: ['Rust Golem', 'Tin Wraith', 'Gear Gremlin'],  elite: 'The Cannery Golem' }, // epic
  { name: 'The Night Market', reward: 'nebula',    enemies: ['Lantern Wisp', 'Neon Stray', 'Firework Imp'], elite: 'Smoke Phantom' },   // epic
  { name: 'The Archive',      reward: 'crimson',   enemies: ['Ink Blob', 'Paper Wraith', 'Cipher Sprite'], elite: 'The Tome Golem' },   // rare
  { name: 'The Void',         reward: 'eclipse',   enemies: ['Void Bunny', 'Null Golem', 'Glitch Cat'],    elite: 'The Void Maw' },     // epic
  { name: 'The Summit',       reward: 'isotope',   enemies: ['Star Lynx', 'Comet Slime', 'Cosmic Wraith'], elite: 'The Last Meow' },    // mythic
];

const NODES_PER_CHAPTER = 5;

/** Parse 'ch3_n2' → { chapter: 3, node: 2 } (1-indexed) or null. */
function parseNodeId(nodeId) {
  const m = /^ch(\d+)_n(\d+)$/.exec(nodeId || '');
  if (!m) return null;
  const chapter = parseInt(m[1], 10);
  const node = parseInt(m[2], 10);
  if (chapter < 1 || chapter > DISTRICTS.length || node < 1 || node > NODES_PER_CHAPTER) return null;
  return { chapter, node };
}

function makeNodeId(chapter, node) {
  return `ch${chapter}_n${node}`;
}

/** Linear depth of a node across the whole chain (1..45). */
function nodeDepth(chapter, node) {
  return (chapter - 1) * NODES_PER_CHAPTER + node;
}

/** The 5th node of each chapter is an elite (mini-boss). */
function isElite(node) {
  return node === NODES_PER_CHAPTER;
}

/** Generate one enemy's combat stats from its level. `opts.boss` marks a district
 *  boss and `opts.hpMult` inflates its HP into a proper boss pool. */
function buildEnemy(level, name, opts = {}) {
  const hpMult = opts.hpMult || 1;
  return {
    name,
    level,
    isEnemy: true,
    isBoss: !!opts.boss,
    role: 'Enemy',
    buffValue: 0,
    stats: {
      hp:   Math.round((40 + level * 18) * hpMult),
      atk:  Math.round(8 + level * 2.5),
      def:  Math.round(4 + level * 1.5),
      spd:  Math.round(8 + level),
      crit: 5,
    },
  };
}

/**
 * Materialize the enemy party for a node. Depth drives enemy level; elites get
 * an extra, tougher enemy. Deterministic (no RNG) so the encounter is stable.
 */
function buildEnemies(chapter, node) {
  const depth = nodeDepth(chapter, node);
  // Enemy level tracks node depth (ch1: 1–5). Was depth+1, but that put even the
  // first node above a fresh starting party; anchoring at depth lets the L3
  // starter party clear the tutorial chapter while later chapters still ramp.
  const level = depth;
  const elite = isElite(node);
  const count = elite ? 3 : (node >= 3 ? 3 : 2);
  const pool = DISTRICTS[chapter - 1].enemies;
  const eliteName = DISTRICTS[chapter - 1].elite;
  const enemies = [];
  for (let i = 0; i < count; i++) {
    const isBoss = elite && i === count - 1;
    if (isBoss) {
      // The chapter-ending boss: +35% level AND a big HP pool that scales with the
      // district (ch1 ~2.5×, ch9 ~6.5×), so the final fight is a real boss check
      // that gates the chapter's guaranteed card.
      const bossLevel = Math.round(level * 1.35);
      const hpMult = 2.5 + (chapter - 1) * 0.5;
      enemies.push(buildEnemy(bossLevel, eliteName, { boss: true, hpMult }));
      continue;
    }
    const name = pool[(depth + i) % pool.length];
    enemies.push(buildEnemy(level, name));
  }
  return enemies;
}

/** Public-facing node descriptor. */
function getNode(nodeId) {
  const parsed = parseNodeId(nodeId);
  if (!parsed) return null;
  const { chapter, node } = parsed;
  const district = DISTRICTS[chapter - 1];
  return {
    id: nodeId,
    chapter,
    node,
    districtName: district.name,
    elite: isElite(node),
    tier: node,
    depth: nodeDepth(chapter, node),
    enemies: buildEnemies(chapter, node),
    // Reward card only on the chapter-ending elite node.
    rewardCardId: isElite(node) ? district.reward : null,
  };
}

/** Next node in the linear chain, or null at the end. */
function nextNodeId(nodeId) {
  const parsed = parseNodeId(nodeId);
  if (!parsed) return null;
  let { chapter, node } = parsed;
  if (node < NODES_PER_CHAPTER) return makeNodeId(chapter, node + 1);
  if (chapter < DISTRICTS.length) return makeNodeId(chapter + 1, 1);
  return null; // chain complete
}

/** Full static map for the frontend Story tab. */
function getStoryMap() {
  return DISTRICTS.map((d, ci) => ({
    chapter: ci + 1,
    name: d.name,
    rewardCardId: d.reward,
    nodes: Array.from({ length: NODES_PER_CHAPTER }, (_, ni) => ({
      id: makeNodeId(ci + 1, ni + 1),
      tier: ni + 1,
      elite: isElite(ni + 1),
    })),
  }));
}

const TOTAL_NODES = DISTRICTS.length * NODES_PER_CHAPTER;

module.exports = {
  DISTRICTS,
  NODES_PER_CHAPTER,
  TOTAL_NODES,
  parseNodeId,
  makeNodeId,
  nodeDepth,
  isElite,
  buildEnemy,
  buildEnemies,
  getNode,
  nextNodeId,
  getStoryMap,
};

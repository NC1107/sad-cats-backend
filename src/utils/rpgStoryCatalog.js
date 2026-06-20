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

const DISTRICTS = [
  { name: 'The Alley',        reward: 'slate' },     // uncommon
  { name: 'The Fish Market',  reward: 'specter' },   // legendary
  { name: 'The Rooftops',     reward: 'blossom' },   // rare
  { name: 'The Docks',        reward: 'midas' },     // legendary
  { name: 'The Cannery',      reward: 'cartridge' }, // epic
  { name: 'The Night Market', reward: 'nebula' },    // epic
  { name: 'The Archive',      reward: 'crimson' },   // rare
  { name: 'The Void',         reward: 'eclipse' },   // epic
  { name: 'The Summit',       reward: 'isotope' },   // mythic
];

const NODES_PER_CHAPTER = 5;
const ENEMY_NAMES = ['Dust Bunny', 'Lint Golem', 'Bad Dog', 'Alley Rat', 'Stray', 'Gutter Wraith'];

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

/** Generate one enemy's combat stats from its level. */
function buildEnemy(level, name) {
  return {
    name,
    level,
    isEnemy: true,
    role: 'Enemy',
    buffValue: 0,
    stats: {
      hp:   Math.round(40 + level * 18),
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
  const level = depth + 1;
  const elite = isElite(node);
  const count = elite ? 3 : (node >= 3 ? 3 : 2);
  const enemies = [];
  for (let i = 0; i < count; i++) {
    const name = ENEMY_NAMES[(depth + i) % ENEMY_NAMES.length];
    // Elite's last enemy is the mini-boss: +50% level.
    const lvl = elite && i === count - 1 ? Math.round(level * 1.5) : level;
    enemies.push(buildEnemy(lvl, elite && i === count - 1 ? `${name} (Elite)` : name));
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

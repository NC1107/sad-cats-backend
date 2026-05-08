/**
 * Toy generation and drop logic for boss kills.
 * Pure logic module — no DB calls.
 */

// Maps boss rarity weight ranges to toy type/tier
const TOY_TIERS = [
  { minWeight: 14, maxWeight: 19, type: 'yarn_ball', tier: 1, icon: '\u{1F9F6}', label: 'Yarn Ball' },
  { minWeight: 10, maxWeight: 13, type: 'feather_wand', tier: 2, icon: '\u{1FAB6}', label: 'Feather Wand' },
  { minWeight: 7, maxWeight: 9, type: 'laser_pointer', tier: 3, icon: '\u{1F534}', label: 'Laser Pointer' },
  { minWeight: 5, maxWeight: 6, type: 'catnip_mouse', tier: 4, icon: '\u{1F42D}', label: 'Catnip Mouse' },
  { minWeight: 1, maxWeight: 4, type: 'scratching_post', tier: 5, icon: '\u{1FAB5}', label: 'Scratching Post' },
];

const QUALITY_NAMES = [
  { min: 0.00, max: 0.20, name: 'battle_scarred', label: 'Battle-Scarred', short: 'BS' },
  { min: 0.20, max: 0.40, name: 'well_worn', label: 'Well-Worn', short: 'WW' },
  { min: 0.40, max: 0.60, name: 'field_tested', label: 'Field-Tested', short: 'FT' },
  { min: 0.60, max: 0.85, name: 'minimal_wear', label: 'Minimal Wear', short: 'MW' },
  { min: 0.85, max: 1.00, name: 'factory_new', label: 'Factory New', short: 'FN' },
];

const MAX_TOYS_PER_USER = 500;

// Trade-up paths: 5 of same type -> 1 of next tier
const TOY_TRADE_UPS = {
  yarn_ball: 'feather_wand',
  feather_wand: 'laser_pointer',
  laser_pointer: 'catnip_mouse',
  catnip_mouse: 'scratching_post',
  // scratching_post: null (max tier)
};

/**
 * Get toy tier info from boss rarity weight
 */
const getToyTier = (rarityWeight) => {
  const w = Number(rarityWeight) || 1;
  return TOY_TIERS.find(t => w >= t.minWeight && w <= t.maxWeight) || TOY_TIERS[0];
};

/**
 * Get quality name from float value
 */
const getQualityName = (quality) => {
  for (const q of QUALITY_NAMES) {
    if (quality < q.max || (quality === 1.0 && q.name === 'factory_new')) return q;
  }
  return QUALITY_NAMES[0];
};

// Boss level influences drop quality — higher level = better quality floor + flatter curve
const LEVEL_QUALITY = {
  1: { floor: 0.00, exp: 1.5 },  // Mostly Battle-Scarred
  2: { floor: 0.10, exp: 1.3 },  // BS / Well-Worn
  3: { floor: 0.25, exp: 1.1 },  // WW / Field-Tested
  4: { floor: 0.45, exp: 0.9 },  // FT / Minimal Wear
  5: { floor: 0.65, exp: 0.7 },  // MW / Factory New
};

/**
 * Generate a single toy with given parameters.
 * Boss level shifts quality curve: higher level = higher quality floor and flatter distribution.
 */
const generateToy = (bossName, bossLevel, rarityWeight, qualityFloor = 0) => {
  const tier = getToyTier(rarityWeight);
  const lvl = LEVEL_QUALITY[Number(bossLevel)] || LEVEL_QUALITY[1];
  const effectiveFloor = Math.max(qualityFloor, lvl.floor);
  const rawQuality = Math.pow(Math.random(), lvl.exp);
  const quality = Math.round(Math.max(effectiveFloor, rawQuality) * 10000) / 10000;
  const qualityInfo = getQualityName(quality);

  return {
    toy_type: tier.type,
    tier: tier.tier,
    quality,
    quality_name: qualityInfo.name,
    boss_name: bossName,
    boss_level: Number(bossLevel) || 1,
  };
};

/**
 * Determine toy drops for all contributors after a boss defeat.
 * Contributors must be sorted by damage_dealt DESC.
 * Returns array of { discordId, toys: [...] }
 */
const determineDrops = (contributors, bossProfile) => {
  if (!contributors || contributors.length === 0) return [];

  const rarityWeight = Number(bossProfile.rarityWeight) || 1;
  const bossName = bossProfile.name;
  const bossLevel = bossProfile.bossLevel || 1;
  const drops = [];

  contributors.forEach((contrib, rank) => {
    const discordId = contrib.discord_id;
    const toys = [];

    if (rank === 0) {
      // #1: 2 toys, quality floor 0.40 (FT+)
      toys.push(generateToy(bossName, bossLevel, rarityWeight, 0.40));
      toys.push(generateToy(bossName, bossLevel, rarityWeight, 0.40));
    } else if (rank === 1) {
      // #2: 1 toy, quality floor 0.20 (WW+)
      toys.push(generateToy(bossName, bossLevel, rarityWeight, 0.20));
    } else if (rank === 2) {
      // #3: 1 toy, no floor
      toys.push(generateToy(bossName, bossLevel, rarityWeight, 0));
    } else {
      // Others: 60% chance of 1 toy, no floor
      if (Math.random() < 0.60) {
        toys.push(generateToy(bossName, bossLevel, rarityWeight, 0));
      }
    }

    if (toys.length > 0) {
      drops.push({ discordId, toys });
    }
  });

  return drops;
};

module.exports = {
  TOY_TIERS,
  QUALITY_NAMES,
  MAX_TOYS_PER_USER,
  TOY_TRADE_UPS,
  getToyTier,
  getQualityName,
  generateToy,
  determineDrops,
};

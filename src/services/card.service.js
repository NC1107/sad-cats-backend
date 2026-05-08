/**
 * Card system logic — rarity rolls, pity tracking, catnip conversion.
 * Pure logic module — no DB calls.
 */

// Rarity drop rates (base odds for Standard Case)
const RARITY_ODDS = [
  { rarity: 'common', weight: 0.6500 },
  { rarity: 'uncommon', weight: 0.2000 },
  { rarity: 'rare', weight: 0.1000 },
  { rarity: 'epic', weight: 0.0350 },
  { rarity: 'legendary', weight: 0.0120 },
  { rarity: 'mythic', weight: 0.0030 },
];

// Catnip values when recycling duplicate cards
const CATNIP_VALUES = {
  common: 1,
  uncommon: 3,
  rare: 10,
  epic: 35,
  legendary: 120,
  mythic: 500,
};

// Catnip shop prices (3-5x recycling value)
const CATNIP_SHOP_PRICES = {
  common: 5,
  uncommon: 15,
  rare: 40,
  epic: 140,
  legendary: 500,
  mythic: 2000,
};

// Quality bonus — avg toy float shifts odds from Common toward higher tiers
const QUALITY_BONUS_TIERS = [
  { maxFloat: 0.20, bonus: 0.00 },
  { maxFloat: 0.40, bonus: 0.02 },
  { maxFloat: 0.60, bonus: 0.05 },
  { maxFloat: 0.80, bonus: 0.08 },
  { maxFloat: 1.00, bonus: 0.12 },
];

// Pity thresholds
const PITY_EPIC_THRESHOLD = 30;       // opens without Epic+ -> guaranteed Epic
const PITY_LEGENDARY_THRESHOLD = 100; // opens without Legendary+ -> guaranteed Legendary

// Case types and their toy requirements
const CASE_TYPES = {
  standard: { label: 'Standard Case', toyCount: 5, description: 'Baseline odds' },
  boss: { label: 'Boss Case', toyCount: 3, description: 'Better rare odds (same boss toys)' },
  premium: { label: 'Premium Case', toyCount: 5, description: 'Highest Legendary/Mythic odds (FN quality)' },
};

/**
 * Get quality bonus from average toy float
 */
const getQualityBonus = (avgFloat) => {
  for (const tier of QUALITY_BONUS_TIERS) {
    if (avgFloat <= tier.maxFloat) return tier.bonus;
  }
  return 0.12;
};

/**
 * Compute adjusted rarity odds based on input toy quality
 * The bonus redistributes probability from Common toward higher tiers
 */
const getAdjustedOdds = (avgFloat, caseType) => {
  const bonus = getQualityBonus(avgFloat);

  // Boss case: additional +3% rare shift
  const totalBonus = caseType === 'boss' ? bonus + 0.03 : bonus;

  // Premium case: additional +5% rare shift
  const finalBonus = caseType === 'premium' ? totalBonus + 0.05 : totalBonus;

  if (finalBonus <= 0) return [...RARITY_ODDS];

  // Redistribute: reduce Common, proportionally increase uncommon+
  const odds = RARITY_ODDS.map(o => ({ ...o }));
  const commonIdx = 0;
  const reduction = Math.min(odds[commonIdx].weight * 0.5, finalBonus); // cap at halving Common
  odds[commonIdx].weight -= reduction;

  // Distribute the reduction proportionally to rarer tiers
  const rarerTotal = odds.slice(1).reduce((s, o) => s + o.weight, 0);
  for (let i = 1; i < odds.length; i++) {
    odds[i].weight += reduction * (odds[i].weight / rarerTotal);
  }

  return odds;
};

/**
 * Roll a rarity based on odds array.
 * Returns rarity string (e.g., 'common', 'epic').
 */
const rollRarity = (odds) => {
  const roll = Math.random();
  let cumulative = 0;
  for (const tier of odds) {
    cumulative += tier.weight;
    if (roll < cumulative) return tier.rarity;
  }
  return 'common';
};

/**
 * Apply pity system — override rarity if thresholds are met.
 * @param {string} rolledRarity - The initially rolled rarity
 * @param {number} opensSinceEpic - Opens since last Epic+
 * @param {number} opensSinceLegendary - Opens since last Legendary+
 * @returns {{ rarity: string, wasPity: boolean }}
 */
const applyPity = (rolledRarity, opensSinceEpic, opensSinceLegendary) => {
  const rarityRank = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };
  const rank = rarityRank[rolledRarity] || 0;

  // Legendary pity (highest priority)
  if (opensSinceLegendary >= PITY_LEGENDARY_THRESHOLD && rank < 4) {
    return { rarity: 'legendary', wasPity: true };
  }

  // Epic pity
  if (opensSinceEpic >= PITY_EPIC_THRESHOLD && rank < 3) {
    return { rarity: 'epic', wasPity: true };
  }

  return { rarity: rolledRarity, wasPity: false };
};

/**
 * Pick a random card of the given rarity from the catalog.
 * @param {Array} catalog - Array of cat_cards rows
 * @param {string} rarity - Target rarity
 * @returns {Object|null} Selected card or null if none available
 */
const pickCardOfRarity = (catalog, rarity) => {
  const pool = catalog.filter(c => c.rarity === rarity);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
};

/**
 * Get catnip value for a duplicate card
 */
const getCatnipValue = (rarity) => CATNIP_VALUES[rarity] || 1;

/**
 * Get catnip shop price for a card rarity
 */
const getCatnipShopPrice = (rarity) => CATNIP_SHOP_PRICES[rarity] || 5;

module.exports = {
  RARITY_ODDS,
  CATNIP_VALUES,
  CATNIP_SHOP_PRICES,
  CASE_TYPES,
  PITY_EPIC_THRESHOLD,
  PITY_LEGENDARY_THRESHOLD,
  getQualityBonus,
  getAdjustedOdds,
  rollRarity,
  applyPity,
  pickCardOfRarity,
  getCatnipValue,
  getCatnipShopPrice,
};

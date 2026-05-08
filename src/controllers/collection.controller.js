const cardModel = require('../models/card.model');
const inventoryModel = require('../models/inventory.model');
const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { getIO, pushActivity } = require('../socket');

// ========== Constants ==========

const CASE_TIERS = [
  { tier: 'pristine',  minAvg: 0.85 },
  { tier: 'elite',     minAvg: 0.65 },
  { tier: 'premium',   minAvg: 0.35 },
  { tier: 'standard',  minAvg: 0.15 },
  { tier: 'battered',  minAvg: 0.00 },
];

const DROP_ODDS = {
  battered: [0.750, 0.180, 0.050, 0.015, 0.004, 0.001],
  standard: [0.650, 0.200, 0.100, 0.035, 0.012, 0.003],
  premium:  [0.500, 0.250, 0.150, 0.070, 0.025, 0.005],
  elite:    [0.350, 0.280, 0.200, 0.100, 0.050, 0.020],
  pristine: [0.200, 0.300, 0.250, 0.150, 0.070, 0.030],
};

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

const PITY_EPIC = 30;
const PITY_LEGENDARY = 100;
const PITY_MYTHIC = 500;

const DUPLICATE_CATNIP = {
  common: 100,
  uncommon: 250,
  rare: 500,
  epic: 1000,
  legendary: 3000,
  mythic: 10000,
};

const SHOP_PRICES = {
  battered: 50,
  standard: 100,
  premium: 250,
  elite: 500,
  pristine: 1000,
};

const TOY_SELL_BASE = 1;
const TOY_SELL_QUALITY_BONUS = 2;

const TYPE_BONUS = 0.05; // +5% quality when all 5 toys are the same type

// ========== Helpers ==========

function getCaseTier(avgQuality) {
  for (const { tier, minAvg } of CASE_TIERS) {
    if (avgQuality >= minAvg) return tier;
  }
  return 'battered';
}

function rollRarity(caseTier, pity) {
  if (pity.opensSinceEpic >= PITY_MYTHIC) return 'mythic';
  if (pity.opensSinceLegendary >= PITY_LEGENDARY) return 'legendary';
  if (pity.opensSinceEpic >= PITY_EPIC) return 'epic';

  const odds = DROP_ODDS[caseTier] || DROP_ODDS.battered;
  const roll = Math.random();
  let cumulative = 0;
  for (let i = 0; i < odds.length; i++) {
    cumulative += odds[i];
    if (roll < cumulative) return RARITIES[i];
  }
  return 'common';
}

// Seeded PRNG (mulberry32) — same as boss.model.js
function seedRng(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  let s = Math.abs(h) | 0;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ========== Controllers ==========

/**
 * POST /api/collection/combine
 * Combine 5 toys into a case (goes to inventory, not instant open)
 */
const combineToys = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { toyIds } = req.body;

    if (!Array.isArray(toyIds) || toyIds.length !== 5) {
      throw new ValidationError('Must provide exactly 5 toy IDs');
    }

    const placeholders = toyIds.map((_, i) => `$${i + 2}`).join(', ');
    const verifyResult = await pool.query(
      `SELECT id, quality, toy_type FROM inventory_toys WHERE discord_id = $1 AND id IN (${placeholders})`,
      [discordId, ...toyIds]
    );

    if (verifyResult.rows.length !== 5) {
      throw new ValidationError(`Only found ${verifyResult.rows.length} of 5 toys in your inventory`);
    }

    // Check type bonus — all 5 same toy_type
    const types = new Set(verifyResult.rows.map(t => t.toy_type));
    const typeBonus = types.size === 1;

    let avgQuality = verifyResult.rows.reduce((sum, t) => sum + Number(t.quality), 0) / 5;
    if (typeBonus) {
      avgQuality = Math.min(1.0, avgQuality + TYPE_BONUS);
    }
    const caseTier = getCaseTier(avgQuality);

    // Delete the 5 toys
    await pool.query(
      `DELETE FROM inventory_toys WHERE discord_id = $1 AND id IN (${placeholders})`,
      [discordId, ...toyIds]
    );

    // Insert case into inventory
    const playerCase = await cardModel.insertCase(discordId, caseTier, 'combine');

    res.json({
      success: true,
      case: {
        id: playerCase.id,
        caseTier,
        avgQuality: Number(avgQuality.toFixed(4)),
        typeBonus,
        source: 'combine',
      },
      toysConsumed: 5,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/collection/open
 * Open a case from inventory
 */
const openCase = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { caseId } = req.body;

    if (!caseId) {
      throw new ValidationError('Must provide caseId');
    }

    // Delete case (verifies ownership)
    const playerCase = await cardModel.deleteCase(caseId, discordId);
    if (!playerCase) {
      throw new NotFoundError('Case not found in your inventory');
    }

    const caseTier = playerCase.case_tier;

    // Roll for a card
    const pity = await cardModel.getPityCounters(discordId);
    const wasPity = pity.opensSinceEpic >= PITY_EPIC;
    const rarity = rollRarity(caseTier, pity);

    const cardsOfRarity = await cardModel.getCardsByRarity(rarity);
    if (cardsOfRarity.length === 0) {
      // Refund the case
      await cardModel.insertCase(discordId, caseTier, playerCase.source);
      throw new NotFoundError(`No cards found for rarity: ${rarity}`);
    }
    const card = cardsOfRarity[Math.floor(Math.random() * cardsOfRarity.length)];

    // Check for duplicate
    const ownedIds = await cardModel.getPlayerCardIds(discordId);
    const isDuplicate = ownedIds.has(card.id);
    let catnipEarned = 0;

    if (isDuplicate) {
      catnipEarned = DUPLICATE_CATNIP[rarity] || 5;
      await cardModel.addCatnip(discordId, catnipEarned);
    }

    await cardModel.insertPlayerCard(discordId, card.id, 'case', isDuplicate);

    await cardModel.insertCaseOpen({
      discordId,
      caseType: caseTier,
      toysConsumed: [],
      cardId: card.id,
      rarity,
      wasPity,
      wasDuplicate: isDuplicate,
      catnipReceived: catnipEarned,
    });

    res.json({
      success: true,
      caseTier,
      card: {
        id: card.id,
        cat_name: card.cat_name,
        sprite_file: card.sprite_file,
        rarity: card.rarity,
        set_id: card.set_id,
        buff_type: card.buff_type,
        buff_value: card.buff_value,
        fun_stats: card.fun_stats,
        description: card.description,
      },
      isDuplicate,
      catnipEarned,
      wasPity,
    });

    // Broadcast case opening to activity log
    try {
      const username = req.user.data.username || 'Someone';
      const entry = {
        type: 'shard',
        message: `${username} opened a ${caseTier} case and got ${card.cat_name} (${card.rarity})!`,
        icon: '\u{1F0CF}',
        time: Date.now(),
      };
      const io = getIO();
      if (io) io.to('leaderboard').emit('activity', entry);
      pushActivity(entry);
    } catch (actErr) {
      logger.warn('Failed to broadcast case open activity', { error: actErr.message });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/collection/my-cases
 * Get player's unopened cases
 */
const getMyCases = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const cases = await cardModel.getPlayerCases(discordId);

    res.json({
      success: true,
      cases,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/collection/sell-toys
 */
const sellToys = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { toyIds } = req.body;

    if (!Array.isArray(toyIds) || toyIds.length === 0 || toyIds.length > 50) {
      throw new ValidationError('Must provide 1-50 toy IDs');
    }

    const placeholders = toyIds.map((_, i) => `$${i + 2}`).join(', ');
    const verifyResult = await pool.query(
      `SELECT id, quality FROM inventory_toys WHERE discord_id = $1 AND id IN (${placeholders})`,
      [discordId, ...toyIds]
    );

    if (verifyResult.rows.length === 0) {
      throw new ValidationError('None of these toys are in your inventory');
    }

    let totalCatnip = 0;
    for (const toy of verifyResult.rows) {
      const qualityBonus = Math.floor(Number(toy.quality) * TOY_SELL_QUALITY_BONUS);
      totalCatnip += TOY_SELL_BASE + qualityBonus;
    }

    const foundIds = verifyResult.rows.map(r => r.id);
    const delPlaceholders = foundIds.map((_, i) => `$${i + 2}`).join(', ');
    await pool.query(
      `DELETE FROM inventory_toys WHERE discord_id = $1 AND id IN (${delPlaceholders})`,
      [discordId, ...foundIds]
    );

    const newBalance = await cardModel.addCatnip(discordId, totalCatnip);

    res.json({
      success: true,
      toysSold: verifyResult.rows.length,
      catnipEarned: totalCatnip,
      catnipBalance: newBalance,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/collection/sell-card
 */
const sellCard = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { playerCardId } = req.body;

    if (!playerCardId) {
      throw new ValidationError('Must provide playerCardId');
    }

    const result = await pool.query(
      `SELECT pc.id, pc.card_id, pc.is_duplicate, cc.rarity
       FROM player_cards pc
       JOIN cat_cards cc ON cc.id = pc.card_id
       WHERE pc.id = $1 AND pc.discord_id = $2`,
      [playerCardId, discordId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundError('Card not found in your collection');
    }

    const card = result.rows[0];

    const countResult = await pool.query(
      'SELECT COUNT(*)::int as count FROM player_cards WHERE discord_id = $1 AND card_id = $2',
      [discordId, card.card_id]
    );

    if (countResult.rows[0].count <= 1) {
      throw new ConflictError('Cannot sell your only copy of this card');
    }

    const catnipValue = DUPLICATE_CATNIP[card.rarity] || 5;

    await pool.query('DELETE FROM player_cards WHERE id = $1', [playerCardId]);

    const newBalance = await cardModel.addCatnip(discordId, catnipValue);

    res.json({
      success: true,
      catnipEarned: catnipValue,
      catnipBalance: newBalance,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/collection/shop/buy
 * Buy a case from the daily shop (goes to inventory)
 */
const shopBuyCase = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { itemIndex } = req.body;

    if (itemIndex == null || itemIndex < 0 || itemIndex > 4) {
      throw new ValidationError('Invalid shop item index (0-4)');
    }

    // Buy-once-per-day enforcement
    const todayKey = new Date().toISOString().slice(0, 10);
    const shopKey = 'shop:' + discordId + ':' + todayKey;
    const alreadyBought = await redisClient.sIsMember(shopKey, String(itemIndex));
    if (alreadyBought) {
      return res.status(400).json({ error: 'Already purchased today' });
    }

    // Generate today's shop to get the item
    const dailyItems = generateDailyShop();
    const item = dailyItems[itemIndex];
    if (!item) {
      throw new ValidationError('Invalid shop item');
    }

    const remaining = await cardModel.spendCatnip(discordId, item.price);
    if (remaining === null) {
      const balance = await cardModel.getCatnip(discordId);
      throw new ValidationError(`Not enough catnip. Need ${item.price}, have ${balance}`);
    }

    // Insert case into inventory
    const playerCase = await cardModel.insertCase(discordId, item.tier, 'shop');

    // Track purchase in Redis
    await redisClient.sAdd(shopKey, String(itemIndex));
    await redisClient.expire(shopKey, 86400);

    const finalBalance = await cardModel.getCatnip(discordId);

    res.json({
      success: true,
      case: {
        id: playerCase.id,
        caseTier: item.tier,
        source: 'shop',
      },
      catnipBalance: finalBalance,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Generate 5 daily shop items using seeded PRNG
 */
function generateDailyShop() {
  const dateKey = getTodayKey();
  const rng = seedRng(`shop_${dateKey}`);

  const tiers = Object.keys(SHOP_PRICES);
  const items = [];

  for (let i = 0; i < 5; i++) {
    const tierIndex = Math.floor(rng() * tiers.length);
    const tier = tiers[tierIndex];
    const basePrice = SHOP_PRICES[tier];
    // Price variation: ±20%
    const variation = 0.8 + rng() * 0.4;
    const price = Math.round(basePrice * variation);

    items.push({
      id: i,
      tier,
      price,
      odds: DROP_ODDS[tier],
      rarities: RARITIES,
    });
  }

  return items;
}

/**
 * GET /api/collection/my-cards
 */
const getMyCards = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;

    const [cards, catnip, pity, setProgress] = await Promise.all([
      cardModel.getPlayerCards(discordId),
      cardModel.getCatnip(discordId),
      cardModel.getPityCounters(discordId),
      cardModel.getPlayerSetProgress(discordId),
    ]);

    // Aggregate buff totals from unique owned cards
    const seen = new Set();
    const cardBuffs = { click: 0, passive: 0, auto: 0, boss: 0 };
    for (const c of cards) {
      if (seen.has(c.card_id)) continue;
      seen.add(c.card_id);
      const v = Number(c.buff_value) || 0;
      if (c.buff_type === 'all') {
        cardBuffs.click += v;
        cardBuffs.passive += v;
        cardBuffs.auto += v;
        cardBuffs.boss += v;
      } else if (cardBuffs.hasOwnProperty(c.buff_type)) {
        cardBuffs[c.buff_type] += v;
      }
    }

    res.json({
      success: true,
      cards,
      catnip,
      pity,
      sets: setProgress,
      cardBuffs,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/collection/shop
 * Daily rotating shop
 */
const getShop = async (req, res, next) => {
  try {
    const discordId = req.user?.data?.discordId;
    let catnip = 0;
    let purchasedIndices = [];
    let purchasedToyIndices = [];
    if (discordId) {
      catnip = await cardModel.getCatnip(discordId);
      const todayKey = new Date().toISOString().slice(0, 10);
      const shopKey = 'shop:' + discordId + ':' + todayKey;
      const toyShopKey = 'toyshop:' + discordId + ':' + todayKey;
      const [caseMembers, toyMembers] = await Promise.all([
        redisClient.sMembers(shopKey),
        redisClient.sMembers(toyShopKey),
      ]);
      purchasedIndices = caseMembers.map(Number);
      purchasedToyIndices = toyMembers.map(Number);
    }

    const items = generateDailyShop();
    const toyItems = generateDailyToyShop();

    res.json({
      success: true,
      items,
      toyItems,
      catnip,
      date: getTodayKey(),
      purchasedIndices,
      purchasedToyIndices,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/collection/history
 */
const getHistory = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const history = await cardModel.getCaseHistory(discordId, limit);

    res.json({
      success: true,
      history,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/collection/preview-combine
 */
const previewCombine = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const toyIds = req.query.toyIds ? req.query.toyIds.split(',') : [];

    if (toyIds.length !== 5) {
      throw new ValidationError('Must provide exactly 5 toy IDs');
    }

    const placeholders = toyIds.map((_, i) => `$${i + 2}`).join(', ');
    const result = await pool.query(
      `SELECT id, quality, toy_type FROM inventory_toys WHERE discord_id = $1 AND id IN (${placeholders})`,
      [discordId, ...toyIds]
    );

    if (result.rows.length !== 5) {
      throw new ValidationError(`Only found ${result.rows.length} of 5 toys`);
    }

    const types = new Set(result.rows.map(t => t.toy_type));
    const typeBonus = types.size === 1;

    let avgQuality = result.rows.reduce((sum, t) => sum + Number(t.quality), 0) / 5;
    if (typeBonus) {
      avgQuality = Math.min(1.0, avgQuality + TYPE_BONUS);
    }
    const caseTier = getCaseTier(avgQuality);

    res.json({
      success: true,
      avgQuality: Number(avgQuality.toFixed(4)),
      caseTier,
      typeBonus,
      odds: DROP_ODDS[caseTier],
      rarities: RARITIES,
    });
  } catch (error) {
    next(error);
  }
};

const BOSS_SUMMON_COST = 200;

/**
 * POST /api/collection/shop/summon-boss
 * Spend catnip to summon a random boss. 1/day server-wide limit.
 */
const summonBoss = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const username = req.user.data.username || 'Someone';
    const BossModel = require('../models/boss.model');
    const dateKey = BossModel.getTodayKey();

    // 1/day server-wide limit
    const lockKey = `boss_summon:${dateKey}`;
    const already = await redisClient.set(lockKey, '1', { NX: true, EX: 86400 });
    if (!already) {
      return res.status(409).json({ success: false, error: 'A boss has already been summoned today' });
    }

    // Check catnip
    const catnip = await cardModel.getCatnip(discordId);
    if (catnip < BOSS_SUMMON_COST) {
      await redisClient.del(lockKey); // Release lock on failure
      return res.status(400).json({ success: false, error: `Need ${BOSS_SUMMON_COST} catnip (have ${catnip})` });
    }

    // Pick a weighted-random boss not already spawned today
    const existing = await pool.query('SELECT boss_name FROM cat_bosses WHERE spawn_date = $1', [dateKey]);
    const usedNames = new Set(existing.rows.map(r => r.boss_name));
    const available = BossModel.BOSS_NAMES.filter(b => !usedNames.has(b.name));

    if (available.length === 0) {
      await redisClient.del(lockKey);
      return res.status(409).json({ success: false, error: 'All bosses already spawned today' });
    }

    const totalWeight = available.reduce((sum, b) => sum + (Number(b.rarityWeight) || 1), 0);
    let roll = Math.random() * totalWeight;
    let chosen = available[available.length - 1];
    for (const boss of available) {
      roll -= (Number(boss.rarityWeight) || 1);
      if (roll <= 0) { chosen = boss; break; }
    }

    // Weighted random level (favors lower levels)
    const r = Math.random();
    const selectedLevel = r < 0.60 ? 1 : r < 0.83 ? 2 : r < 0.93 ? 3 : r < 0.98 ? 4 : 5;
    const lvl = BossModel.BOSS_LEVELS[selectedLevel - 1] || BossModel.BOSS_LEVELS[0];
    const hpRange = BossModel.getScaledHpRange(selectedLevel, chosen.name);
    const hp = String(Math.floor(Math.random() * (hpRange.maxHP - hpRange.minHP + 1)) + hpRange.minHP);

    const result = await pool.query(
      `INSERT INTO cat_bosses (week_key, boss_name, boss_emoji, max_hp, current_hp, reward_pool, boss_level, buff_duration_minutes, spawn_date)
       VALUES ($1, $2, $3, $4::BIGINT, $4::BIGINT, 0, $5, $6, $7)
       ON CONFLICT (spawn_date, boss_name) DO NOTHING
       RETURNING *`,
      [null, chosen.name, chosen.emoji, hp, selectedLevel, lvl.buffMinutes, dateKey]
    );

    if (result.rows.length === 0) {
      await redisClient.del(lockKey);
      return res.status(409).json({ success: false, error: `${chosen.name} already spawned today` });
    }

    // Deduct catnip
    await cardModel.addCatnip(discordId, -BOSS_SUMMON_COST);

    logger.info('Player summoned boss', { discordId, boss: chosen.name, level: selectedLevel, hp });

    // Broadcast activity
    const entry = {
      type: 'boss',
      message: `${username} summoned ${chosen.emoji} ${chosen.name} (Lv.${selectedLevel})!`,
      icon: '\u{1F52E}',
      time: Date.now(),
    };
    const io = getIO();
    if (io) io.to('leaderboard').emit('activity', entry);
    pushActivity(entry);

    res.json({ success: true, boss: result.rows[0], catnipSpent: BOSS_SUMMON_COST });
  } catch (error) {
    next(error);
  }
};

// ========== Toy Shop ==========

const TOY_SHOP_PRICES = {
  yarn_ball: 50,
  feather_wand: 150,
  laser_pointer: 400,
  catnip_mouse: 1000,
  scratching_post: 3000,
};

const QUALITY_MULTIPLIERS = {
  battle_scarred: 0.5,
  well_worn: 1,
  field_tested: 1.5,
  minimal_wear: 2,
  factory_new: 3,
};

const QUALITY_VALUES = {
  battle_scarred: 0.10,
  well_worn: 0.30,
  field_tested: 0.50,
  minimal_wear: 0.75,
  factory_new: 0.95,
};

const TOY_TIER_MAP = {
  yarn_ball: 1,
  feather_wand: 2,
  laser_pointer: 3,
  catnip_mouse: 4,
  scratching_post: 5,
};

const TOY_TYPES_LIST = Object.keys(TOY_SHOP_PRICES);
const QUALITY_NAMES_LIST = Object.keys(QUALITY_MULTIPLIERS);

const TOY_ICONS = {
  yarn_ball: '\u{1F9F6}',
  feather_wand: '\u{1FAB6}',
  laser_pointer: '\u{1F534}',
  catnip_mouse: '\u{1F42D}',
  scratching_post: '\u{1FAB5}',
};

const TOY_LABELS = {
  yarn_ball: 'Yarn Ball',
  feather_wand: 'Feather Wand',
  laser_pointer: 'Laser Pointer',
  catnip_mouse: 'Catnip Mouse',
  scratching_post: 'Scratching Post',
};

const QUALITY_LABELS = {
  battle_scarred: 'Battle-Scarred',
  well_worn: 'Well-Worn',
  field_tested: 'Field-Tested',
  minimal_wear: 'Minimal Wear',
  factory_new: 'Factory New',
};

/**
 * Generate 5 daily toy shop items using seeded PRNG
 */
function generateDailyToyShop() {
  const dateKey = getTodayKey();
  const rng = seedRng(`toyshop_${dateKey}`);
  const items = [];

  for (let i = 0; i < 5; i++) {
    const toyType = TOY_TYPES_LIST[Math.floor(rng() * TOY_TYPES_LIST.length)];
    const qualityName = QUALITY_NAMES_LIST[Math.floor(rng() * QUALITY_NAMES_LIST.length)];
    const basePrice = TOY_SHOP_PRICES[toyType];
    const mult = QUALITY_MULTIPLIERS[qualityName];
    const variation = 0.8 + rng() * 0.4;
    const shopDiscount = 0.6; // Daily deals are 40% off
    const price = Math.round(basePrice * mult * variation * shopDiscount);

    items.push({
      id: i,
      toyType,
      qualityName,
      icon: TOY_ICONS[toyType],
      label: TOY_LABELS[toyType],
      qualityLabel: QUALITY_LABELS[qualityName],
      price,
    });
  }

  return items;
}

/**
 * POST /api/collection/shop/buy-toy
 */
const shopBuyToy = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { itemIndex } = req.body;

    // Validate item index
    const toyItems = generateDailyToyShop();
    const item = toyItems[itemIndex];
    if (!item) {
      return res.status(400).json({ error: 'Invalid toy shop item' });
    }

    // Check buy-once per day
    const todayKey = new Date().toISOString().slice(0, 10);
    const shopKey = 'toyshop:' + discordId + ':' + todayKey;
    const alreadyBought = await redisClient.sIsMember(shopKey, String(itemIndex));
    if (alreadyBought) {
      return res.status(400).json({ error: 'Already purchased today' });
    }

    // Check catnip balance
    const catnipRow = await cardModel.getCatnip(discordId);
    const balance = catnipRow || 0;
    if (balance < item.price) {
      return res.status(400).json({ error: 'Not enough catnip' });
    }

    // Check toy limit
    const toyCount = await inventoryModel.getToyCount(discordId);
    if (toyCount >= 500) {
      return res.status(400).json({ error: 'Toy inventory full (500 max)' });
    }

    // Deduct catnip
    await cardModel.addCatnip(discordId, -item.price);

    // Insert toy
    const quality = QUALITY_VALUES[item.qualityName];
    const toy = {
      discord_id: discordId,
      toy_type: item.toyType,
      tier: TOY_TIER_MAP[item.toyType],
      quality,
      quality_name: item.qualityName,
      boss_name: 'Shop',
      boss_level: 0,
      source_boss_id: null,
    };
    const inserted = await inventoryModel.insertToys([toy]);

    // Track purchase in Redis
    await redisClient.sAdd(shopKey, String(itemIndex));
    await redisClient.expire(shopKey, 86400);

    const finalBalance = await cardModel.getCatnip(discordId);

    res.json({
      success: true,
      toy: inserted[0],
      catnipBalance: finalBalance,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/collection/cards/:discordId — Public endpoint for any user's collection
 */
const getPublicCards = async (req, res, next) => {
  try {
    const { discordId } = req.params;
    if (!/^\d{17,20}$/.test(discordId)) {
      return res.status(400).json({ error: 'Invalid Discord ID' });
    }

    const [cards, setProgress] = await Promise.all([
      cardModel.getPlayerCards(discordId),
      cardModel.getPlayerSetProgress(discordId),
    ]);

    // Aggregate buff totals from unique owned cards
    const seen = new Set();
    const cardBuffs = { click: 0, passive: 0, auto: 0, boss: 0 };
    for (const c of cards) {
      if (seen.has(c.card_id)) continue;
      seen.add(c.card_id);
      const v = Number(c.buff_value) || 0;
      if (c.buff_type === 'all') {
        cardBuffs.click += v;
        cardBuffs.passive += v;
        cardBuffs.auto += v;
        cardBuffs.boss += v;
      } else if (cardBuffs.hasOwnProperty(c.buff_type)) {
        cardBuffs[c.buff_type] += v;
      }
    }

    // Count by rarity
    const uniqueCards = [];
    const seenIds = new Set();
    for (const c of cards) {
      if (!seenIds.has(c.card_id)) {
        seenIds.add(c.card_id);
        uniqueCards.push(c);
      }
    }
    const rarityCounts = {};
    for (const c of uniqueCards) {
      rarityCounts[c.rarity] = (rarityCounts[c.rarity] || 0) + 1;
    }

    res.json({
      success: true,
      totalOwned: uniqueCards.length,
      rarityCounts,
      sets: setProgress,
      cardBuffs,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/collection/favorites — Set favorite cats (max 5)
 */
const setFavorites = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { cardIds } = req.body;

    if (!Array.isArray(cardIds) || cardIds.length > 5) {
      return res.status(400).json({ error: 'Must be an array of up to 5 card IDs' });
    }

    // Validate ownership
    if (cardIds.length > 0) {
      const owned = await cardModel.getPlayerCards(discordId);
      const ownedIds = new Set(owned.map(c => c.card_id));
      for (const id of cardIds) {
        if (!ownedIds.has(id)) {
          return res.status(400).json({ error: `You don't own card: ${id}` });
        }
      }
    }

    await pool.query(
      'UPDATE scores SET favorite_cats = $1 WHERE discord_id = $2::TEXT',
      [JSON.stringify(cardIds), discordId]
    );

    res.json({ success: true, favorites: cardIds });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/collection/favorites/:discordId — Public favorites for any user
 */
const getFavorites = async (req, res, next) => {
  try {
    const { discordId } = req.params;
    if (!/^\d{17,20}$/.test(discordId)) {
      return res.status(400).json({ error: 'Invalid Discord ID' });
    }

    const result = await pool.query(
      'SELECT favorite_cats FROM scores WHERE discord_id = $1::TEXT',
      [discordId]
    );

    const favorites = result.rows[0]?.favorite_cats || [];
    res.json({ success: true, favorites });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  combineToys,
  openCase,
  getMyCases: getMyCases,
  getPlayerCases: getMyCases,
  sellToys,
  sellCard,
  shopBuyCase,
  getMyCards,
  getShop,
  getHistory,
  previewCombine,
  summonBoss,
  getPublicCards,
  shopBuyToy,
  setFavorites,
  getFavorites,
};

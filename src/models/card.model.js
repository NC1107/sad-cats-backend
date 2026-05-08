const pool = require('../config/database');
const logger = require('../utils/logger');
const { InternalError } = require('../utils/errors');

// ========== Card Catalog ==========

/**
 * Get all cat cards from catalog (for rarity pool selection)
 */
const getAllCards = async () => {
  try {
    const result = await pool.query(
      'SELECT * FROM cat_cards ORDER BY rarity, cat_name'
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting card catalog', { error: error.message });
    throw new InternalError('Failed to get card catalog');
  }
};

/**
 * Get a single card by ID
 */
const getCard = async (cardId) => {
  try {
    const result = await pool.query('SELECT * FROM cat_cards WHERE id = $1', [cardId]);
    return result.rows[0] || null;
  } catch (error) {
    logger.error('Error getting card', { error: error.message, cardId });
    throw new InternalError('Failed to get card');
  }
};

/**
 * Get cards by rarity
 */
const getCardsByRarity = async (rarity) => {
  try {
    const result = await pool.query(
      'SELECT * FROM cat_cards WHERE rarity = $1 ORDER BY cat_name',
      [rarity]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting cards by rarity', { error: error.message, rarity });
    throw new InternalError('Failed to get cards');
  }
};

// ========== Card Sets ==========

/**
 * Get all card sets with their cards
 */
const getAllSets = async () => {
  try {
    const [sets, cards] = await Promise.all([
      pool.query('SELECT * FROM card_sets ORDER BY name'),
      pool.query('SELECT id, cat_name, sprite_file, rarity, set_id FROM cat_cards ORDER BY rarity, cat_name'),
    ]);

    return sets.rows.map(set => ({
      ...set,
      cards: cards.rows.filter(c => c.set_id === set.id),
    }));
  } catch (error) {
    logger.error('Error getting card sets', { error: error.message });
    throw new InternalError('Failed to get card sets');
  }
};

// ========== Player Cards ==========

/**
 * Get a player's card collection
 */
const getPlayerCards = async (discordId) => {
  try {
    const result = await pool.query(
      `SELECT pc.id, pc.card_id, pc.obtained_at, pc.source, pc.is_duplicate,
              cc.cat_name, cc.sprite_file, cc.rarity, cc.set_id, cc.buff_type,
              cc.buff_value, cc.fun_stats, cc.description
       FROM player_cards pc
       JOIN cat_cards cc ON cc.id = pc.card_id
       WHERE pc.discord_id = $1
       ORDER BY pc.obtained_at DESC`,
      [discordId]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting player cards', { error: error.message, discordId });
    throw new InternalError('Failed to get player cards');
  }
};

/**
 * Get unique card IDs a player owns (for duplicate detection)
 */
const getPlayerCardIds = async (discordId) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT card_id FROM player_cards WHERE discord_id = $1',
      [discordId]
    );
    return new Set(result.rows.map(r => r.card_id));
  } catch (error) {
    logger.error('Error getting player card IDs', { error: error.message, discordId });
    return new Set();
  }
};

/**
 * Insert a new player card
 */
const insertPlayerCard = async (discordId, cardId, source = 'case', isDuplicate = false) => {
  try {
    const result = await pool.query(
      `INSERT INTO player_cards (discord_id, card_id, source, is_duplicate)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [discordId, cardId, source, isDuplicate]
    );
    return result.rows[0];
  } catch (error) {
    logger.error('Error inserting player card', { error: error.message, discordId, cardId });
    throw new InternalError('Failed to insert player card');
  }
};

/**
 * Get player's set completion progress
 */
const getPlayerSetProgress = async (discordId) => {
  try {
    const result = await pool.query(
      `SELECT cs.id as set_id, cs.name as set_name, cs.bonus_type, cs.bonus_value,
              COUNT(DISTINCT cc.id) as total_cards,
              COUNT(DISTINCT pc.card_id) as owned_cards
       FROM card_sets cs
       JOIN cat_cards cc ON cc.set_id = cs.id
       LEFT JOIN player_cards pc ON pc.card_id = cc.id AND pc.discord_id = $1
       GROUP BY cs.id, cs.name, cs.bonus_type, cs.bonus_value
       ORDER BY cs.name`,
      [discordId]
    );
    return result.rows.map(r => ({
      ...r,
      total_cards: parseInt(r.total_cards),
      owned_cards: parseInt(r.owned_cards),
      complete: parseInt(r.owned_cards) >= parseInt(r.total_cards),
    }));
  } catch (error) {
    logger.error('Error getting player set progress', { error: error.message, discordId });
    throw new InternalError('Failed to get set progress');
  }
};

// ========== Case Opens ==========

/**
 * Record a case opening
 */
const insertCaseOpen = async ({
  discordId, caseType, toysConsumed, cardId,
  rarity, wasPity, wasDuplicate, catnipReceived,
}) => {
  try {
    const result = await pool.query(
      `INSERT INTO case_opens (discord_id, case_type, toys_consumed, card_id, rarity, was_pity, was_duplicate, catnip_received)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [discordId, caseType, JSON.stringify(toysConsumed), cardId, rarity, wasPity, wasDuplicate, catnipReceived]
    );
    return result.rows[0];
  } catch (error) {
    logger.error('Error inserting case open', { error: error.message, discordId });
    throw new InternalError('Failed to record case open');
  }
};

/**
 * Get case open history for a player
 */
const getCaseHistory = async (discordId, limit = 50) => {
  try {
    const result = await pool.query(
      `SELECT co.*, cc.cat_name, cc.sprite_file
       FROM case_opens co
       LEFT JOIN cat_cards cc ON cc.id = co.card_id
       WHERE co.discord_id = $1
       ORDER BY co.opened_at DESC
       LIMIT $2`,
      [discordId, limit]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting case history', { error: error.message, discordId });
    throw new InternalError('Failed to get case history');
  }
};

/**
 * Count opens since last rarity threshold (for pity system)
 * Returns { opensSinceEpic, opensSinceLegendary }
 */
const getPityCounters = async (discordId) => {
  try {
    // Count opens since last epic+
    const epicResult = await pool.query(
      `SELECT COUNT(*)::int as count FROM case_opens
       WHERE discord_id = $1
         AND opened_at > COALESCE(
           (SELECT MAX(opened_at) FROM case_opens
            WHERE discord_id = $1 AND rarity IN ('epic', 'legendary', 'mythic')),
           '1970-01-01'
         )`,
      [discordId]
    );

    // Count opens since last legendary+
    const legendaryResult = await pool.query(
      `SELECT COUNT(*)::int as count FROM case_opens
       WHERE discord_id = $1
         AND opened_at > COALESCE(
           (SELECT MAX(opened_at) FROM case_opens
            WHERE discord_id = $1 AND rarity IN ('legendary', 'mythic')),
           '1970-01-01'
         )`,
      [discordId]
    );

    return {
      opensSinceEpic: epicResult.rows[0]?.count || 0,
      opensSinceLegendary: legendaryResult.rows[0]?.count || 0,
    };
  } catch (error) {
    logger.error('Error getting pity counters', { error: error.message, discordId });
    return { opensSinceEpic: 0, opensSinceLegendary: 0 };
  }
};

// ========== Catnip ==========

/**
 * Add catnip to a player's balance
 */
const addCatnip = async (discordId, amount) => {
  try {
    const result = await pool.query(
      'UPDATE scores SET catnip = COALESCE(catnip, 0) + $1 WHERE discord_id = $2 RETURNING catnip',
      [amount, discordId]
    );
    return result.rows[0]?.catnip || 0;
  } catch (error) {
    logger.error('Error adding catnip', { error: error.message, discordId, amount });
    throw new InternalError('Failed to add catnip');
  }
};

/**
 * Spend catnip (returns false if insufficient)
 */
const spendCatnip = async (discordId, amount) => {
  try {
    const result = await pool.query(
      `UPDATE scores SET catnip = catnip - $1
       WHERE discord_id = $2 AND COALESCE(catnip, 0) >= $1
       RETURNING catnip`,
      [amount, discordId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].catnip;
  } catch (error) {
    logger.error('Error spending catnip', { error: error.message, discordId, amount });
    throw new InternalError('Failed to spend catnip');
  }
};

/**
 * Get player's catnip balance
 */
const getCatnip = async (discordId) => {
  try {
    const result = await pool.query(
      'SELECT COALESCE(catnip, 0) as catnip FROM scores WHERE discord_id = $1',
      [discordId]
    );
    return result.rows[0]?.catnip || 0;
  } catch (error) {
    logger.error('Error getting catnip', { error: error.message, discordId });
    return 0;
  }
};

// ========== Player Cases (inventory) ==========

const insertCase = async (discordId, caseTier, source = 'combine') => {
  try {
    const result = await pool.query(
      `INSERT INTO player_cases (discord_id, case_tier, source)
       VALUES ($1, $2, $3) RETURNING *`,
      [discordId, caseTier, source]
    );
    return result.rows[0];
  } catch (error) {
    logger.error('Error inserting case', { error: error.message, discordId });
    throw new InternalError('Failed to insert case');
  }
};

const getPlayerCases = async (discordId) => {
  try {
    const result = await pool.query(
      'SELECT * FROM player_cases WHERE discord_id = $1 ORDER BY obtained_at DESC',
      [discordId]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting player cases', { error: error.message, discordId });
    throw new InternalError('Failed to get player cases');
  }
};

const deleteCase = async (caseId, discordId) => {
  try {
    const result = await pool.query(
      'DELETE FROM player_cases WHERE id = $1 AND discord_id = $2 RETURNING *',
      [caseId, discordId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error('Error deleting case', { error: error.message, caseId, discordId });
    throw new InternalError('Failed to delete case');
  }
};

module.exports = {
  getAllCards,
  getCard,
  getCardsByRarity,
  getAllSets,
  getPlayerCards,
  getPlayerCardIds,
  insertPlayerCard,
  getPlayerSetProgress,
  insertCaseOpen,
  getCaseHistory,
  getPityCounters,
  addCatnip,
  spendCatnip,
  getCatnip,
  insertCase,
  getPlayerCases,
  deleteCase,
};

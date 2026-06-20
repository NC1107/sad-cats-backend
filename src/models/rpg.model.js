const pool = require('../config/database');
const logger = require('../utils/logger');
const { InternalError } = require('../utils/errors');

// ========== Cat stats ==========

/**
 * Every owned card joined to its catalog metadata and (lazily-created) RPG
 * progression. A card with no player_cat_stats row yet reads as level 1 / xp 0
 * via COALESCE, so existing collections need no eager backfill.
 */
const getCatRows = async (discordId, executor = pool) => {
  try {
    const result = await executor.query(
      `SELECT pc.id              AS player_card_id,
              pc.card_id,
              pc.obtained_at,
              cc.cat_name, cc.sprite_file, cc.rarity, cc.set_id,
              cc.buff_type, cc.buff_value, cc.fun_stats,
              COALESCE(s.level, 1)   AS level,
              COALESCE(s.xp, 0)      AS xp,
              s.stamina,
              s.stamina_updated_at
       FROM player_cards pc
       JOIN cat_cards cc ON cc.id = pc.card_id
       LEFT JOIN player_cat_stats s ON s.player_card_id = pc.id
       WHERE pc.discord_id = $1
       ORDER BY COALESCE(s.level, 1) DESC, pc.obtained_at DESC`,
      [discordId]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting cat rows', { error: error.message, discordId });
    throw new InternalError('Failed to get cats');
  }
};

/**
 * Lazily ensure a progression row exists for a card, then return it.
 * Used before any mutation (XP grant, stamina spend).
 */
const ensureStatRow = async (discordId, cardId, playerCardId, executor = pool) => {
  try {
    const result = await executor.query(
      `INSERT INTO player_cat_stats (player_card_id, discord_id, card_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_card_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [playerCardId, discordId, cardId]
    );
    return result.rows[0];
  } catch (error) {
    logger.error('Error ensuring stat row', { error: error.message, playerCardId });
    throw new InternalError('Failed to initialize cat stats');
  }
};

/** Set a card's level + xp directly (used by the one-time starter gift). */
const setLevelXp = async (playerCardId, discordId, cardId, level, xp, executor = pool) => {
  try {
    await executor.query(
      `INSERT INTO player_cat_stats (player_card_id, discord_id, card_id, level, xp)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (player_card_id)
       DO UPDATE SET level = EXCLUDED.level, xp = EXCLUDED.xp, updated_at = NOW()`,
      [playerCardId, discordId, cardId, level, xp]
    );
  } catch (error) {
    logger.error('Error setting level/xp', { error: error.message, playerCardId });
    throw new InternalError('Failed to set cat level');
  }
};

/** Sum of all owned cats' levels — feeds rosterBonus. */
const getTotalCatLevels = async (discordId, executor = pool) => {
  try {
    // Cards with no stat row count as level 1.
    const result = await executor.query(
      `SELECT COALESCE(SUM(COALESCE(s.level, 1)), 0)::int AS total
       FROM player_cards pc
       LEFT JOIN player_cat_stats s ON s.player_card_id = pc.id
       WHERE pc.discord_id = $1`,
      [discordId]
    );
    return result.rows[0]?.total || 0;
  } catch (error) {
    logger.error('Error summing cat levels', { error: error.message, discordId });
    return 0;
  }
};

// ========== Starter gift ==========

const hasStarterGrant = async (discordId, executor = pool) => {
  try {
    const result = await executor.query(
      'SELECT 1 FROM rpg_starter_grants WHERE discord_id = $1',
      [discordId]
    );
    return result.rows.length > 0;
  } catch (error) {
    logger.error('Error checking starter grant', { error: error.message, discordId });
    return true; // fail safe: skip the gift rather than risk double-granting
  }
};

const markStarterGrant = async (discordId, executor = pool) => {
  try {
    await executor.query(
      'INSERT INTO rpg_starter_grants (discord_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [discordId]
    );
  } catch (error) {
    logger.error('Error marking starter grant', { error: error.message, discordId });
    throw new InternalError('Failed to record starter grant');
  }
};

// ========== Party ==========

const getPartySlots = async (discordId, executor = pool) => {
  try {
    const result = await executor.query(
      'SELECT slot, player_card_id FROM player_party WHERE discord_id = $1 ORDER BY slot',
      [discordId]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting party', { error: error.message, discordId });
    throw new InternalError('Failed to get party');
  }
};

/** Owned player_card_ids out of the provided list (ownership check). */
const filterOwnedCardIds = async (discordId, playerCardIds, executor = pool) => {
  try {
    if (!playerCardIds.length) return new Set();
    const result = await executor.query(
      'SELECT id FROM player_cards WHERE discord_id = $1 AND id = ANY($2::uuid[])',
      [discordId, playerCardIds]
    );
    return new Set(result.rows.map(r => r.id));
  } catch (error) {
    logger.error('Error checking card ownership', { error: error.message, discordId });
    throw new InternalError('Failed to validate party');
  }
};

const clearParty = async (discordId, executor = pool) => {
  await executor.query('DELETE FROM player_party WHERE discord_id = $1', [discordId]);
};

const insertPartySlot = async (discordId, playerCardId, slot, executor = pool) => {
  await executor.query(
    `INSERT INTO player_party (discord_id, player_card_id, slot)
     VALUES ($1, $2, $3)`,
    [discordId, playerCardId, slot]
  );
};

module.exports = {
  getCatRows,
  ensureStatRow,
  setLevelXp,
  getTotalCatLevels,
  hasStarterGrant,
  markStarterGrant,
  getPartySlots,
  filterOwnedCardIds,
  clearParty,
  insertPartySlot,
};

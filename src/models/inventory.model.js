const pool = require('../config/database');
const logger = require('../utils/logger');
const { InternalError } = require('../utils/errors');

/**
 * Bulk insert toys into inventory_toys table.
 * Each toy: { discord_id, toy_type, tier, quality, quality_name, boss_name, boss_level, source_boss_id }
 */
const insertToys = async (toys, executor = pool) => {
  if (!toys || toys.length === 0) return [];
  try {
    const values = [];
    const params = [];
    let idx = 1;

    for (const t of toys) {
      values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
      params.push(t.discord_id, t.toy_type, t.tier, t.quality, t.quality_name, t.boss_name, t.boss_level, t.source_boss_id);
      idx += 8;
    }

    const query = `
      INSERT INTO inventory_toys (discord_id, toy_type, tier, quality, quality_name, boss_name, boss_level, source_boss_id)
      VALUES ${values.join(', ')}
      RETURNING *
    `;

    const result = await executor.query(query, params);
    return result.rows;
  } catch (error) {
    logger.error('Error inserting toys', { error: error.message, count: toys.length });
    throw new InternalError('Failed to insert toys');
  }
};

/**
 * Get paginated toys for a user, newest first
 */
const getToys = async (discordId, { limit = 50, offset = 0 } = {}) => {
  try {
    const result = await pool.query(
      `SELECT id, toy_type, tier, quality, quality_name, boss_name, boss_level, source_boss_id, obtained_at
       FROM inventory_toys
       WHERE discord_id = $1
       ORDER BY obtained_at DESC
       LIMIT $2 OFFSET $3`,
      [discordId, limit, offset]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting toys', { error: error.message, discordId });
    throw new InternalError('Failed to get toys');
  }
};

/**
 * Get per-type toy counts for a user
 */
const getToyCounts = async (discordId) => {
  try {
    const result = await pool.query(
      `SELECT toy_type, tier, COUNT(*)::int as count
       FROM inventory_toys
       WHERE discord_id = $1
       GROUP BY toy_type, tier
       ORDER BY tier ASC`,
      [discordId]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting toy counts', { error: error.message, discordId });
    throw new InternalError('Failed to get toy counts');
  }
};

/**
 * Get total toy count for a user (for cap check)
 */
const getToyCount = async (discordId, executor = pool) => {
  try {
    const result = await executor.query(
      'SELECT COUNT(*)::int as count FROM inventory_toys WHERE discord_id = $1',
      [discordId]
    );
    return result.rows[0].count;
  } catch (error) {
    logger.error('Error getting toy count', { error: error.message, discordId });
    return 0;
  }
};

/**
 * Get toy counts for multiple users at once (for leaderboard)
 */
const getToyCountsBatch = async (discordIds) => {
  if (!discordIds || discordIds.length === 0) return {};
  try {
    const result = await pool.query(
      `SELECT discord_id, COUNT(*)::int as count
       FROM inventory_toys
       WHERE discord_id = ANY($1)
       GROUP BY discord_id`,
      [discordIds]
    );
    const map = {};
    for (const row of result.rows) {
      map[row.discord_id] = row.count;
    }
    return map;
  } catch (error) {
    logger.error('Error getting batch toy counts', { error: error.message });
    return {};
  }
};

/**
 * Delete oldest toys for a user to make room
 */
const deleteOldestToys = async (discordId, count) => {
  try {
    await pool.query(
      `DELETE FROM inventory_toys
       WHERE id IN (
         SELECT id FROM inventory_toys
         WHERE discord_id = $1
         ORDER BY obtained_at ASC
         LIMIT $2
       )`,
      [discordId, count]
    );
  } catch (error) {
    logger.error('Error deleting oldest toys', { error: error.message, discordId });
  }
};

module.exports = {
  insertToys,
  getToys,
  getToyCounts,
  getToyCount,
  getToyCountsBatch,
  deleteOldestToys,
};

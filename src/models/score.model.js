const pool = require('../config/database');
const logger = require('../utils/logger');
const { InternalError, NotFoundError } = require('../utils/errors');

// Threshold where JS Number() loses integer precision — used for the "first infinity" speedrun
// milestone. Independent of SCORE_CAP; players cross this long before approaching the ceiling.
const INFINITY_THRESHOLD = '9007199254740991'; // Number.MAX_SAFE_INTEGER

// Score ceiling — lifted from 1e27 to 1e308 alongside the BIGINT → NUMERIC column migration.
// Decimal-class library on the frontend already supports far higher; column is NUMERIC so storage
// is fine. Players will functionally never reach this; it's a defense-in-depth clamp against
// runaway-multiplier bugs, not a balance lever.
const SCORE_CAP = '1' + '0'.repeat(308); // 10^308

/**
 * Atomically add to (or subtract from) a user's score
 * @param {Object} scoreData - Score data with delta
 * @param {string} scoreData.discordId - Discord user ID
 * @param {string} scoreData.username - Discord username
 * @param {string|null} scoreData.avatarUrl - Avatar URL
 * @param {number} scoreData.delta - Amount to add (positive) or subtract (negative)
 * @param {string|null} scoreData.userId - Optional UUID for authenticated requests
 * @param {boolean} scoreData.allowNegative - If true, allow score to go below zero (bot-only)
 * @returns {Promise<Object>} Updated score record
 */
const addToScore = async (scoreData) => {
  const { userId, discordId, username, avatarUrl, delta, allowNegative, source } = scoreData;
  const isGambling = source === 'gambling';

  try {
    let query, values;
    // Clamp all positive growth to SCORE_CAP; allow negative for bot penalties when flagged
    // For non-allowNegative UPDATE: use LEAST(score, 0) as floor so existing debt is
    // worked off gradually instead of jumping to 0 on the next web sync
    const scoreExpr = allowNegative
      ? `LEAST(${SCORE_CAP}::NUMERIC, scores.score + `
      : `LEAST(${SCORE_CAP}::NUMERIC, GREATEST(LEAST(scores.score, 0), scores.score + `;
    const scoreEnd = allowNegative ? ')' : '))';
    const insertExpr = allowNegative
      ? `LEAST(${SCORE_CAP}::NUMERIC, `
      : `LEAST(${SCORE_CAP}::NUMERIC, GREATEST(0, `;
    const insertEnd = allowNegative ? ')' : '))';
    const gamblingExpr = isGambling ? `, gambling_net = scores.gambling_net + ` : '';
    const gamblingInsertCol = isGambling ? ', gambling_net' : '';

    if (userId) {
      const deltaParam = '$5';
      const gamblingEnd = isGambling ? `${deltaParam}::NUMERIC` : '';
      const gamblingInsertVal = isGambling ? `, ${deltaParam}::NUMERIC` : '';
      query = `
        INSERT INTO scores (user_id, discord_id, username, avatar_url, score${gamblingInsertCol}, updated_at)
        VALUES ($1, $2, $3, $4, ${insertExpr}${deltaParam}::NUMERIC${insertEnd}${gamblingInsertVal}, NOW())
        ON CONFLICT (discord_id)
        DO UPDATE SET
          score = ${scoreExpr}${deltaParam}::NUMERIC${scoreEnd},
          username = EXCLUDED.username,
          avatar_url = EXCLUDED.avatar_url${gamblingExpr}${gamblingEnd},
          updated_at = NOW()
        RETURNING *;
      `;
      values = [userId, discordId, username, avatarUrl, delta];
    } else {
      const deltaParam = '$4';
      const gamblingEnd = isGambling ? `${deltaParam}::NUMERIC` : '';
      const gamblingInsertVal = isGambling ? `, ${deltaParam}::NUMERIC` : '';
      query = `
        INSERT INTO scores (discord_id, username, avatar_url, score${gamblingInsertCol}, updated_at)
        VALUES ($1, $2, $3, ${insertExpr}${deltaParam}::NUMERIC${insertEnd}${gamblingInsertVal}, NOW())
        ON CONFLICT (discord_id)
        DO UPDATE SET
          score = ${scoreExpr}${deltaParam}::NUMERIC${scoreEnd},
          username = EXCLUDED.username,
          avatar_url = EXCLUDED.avatar_url${gamblingExpr}${gamblingEnd},
          updated_at = NOW()
        RETURNING *;
      `;
      values = [discordId, username, avatarUrl, delta];
    }

    const result = await pool.query(query, values);
    const row = result.rows[0];

    // Soft warning for extreme debt
    if (BigInt(row.score) < -1000000000000n) {
      logger.warn('Extreme debt detected', { discordId, score: row.score });
    }

    // Speedrun: record infinity milestone and best run time
    try {
      if (BigInt(row.score) >= BigInt(INFINITY_THRESHOLD)) {
        // Only record if this run hasn't already hit infinity
        // (first ever, OR new run started after last recorded infinity)
        const result = await pool.query(`
          UPDATE scores SET
            infinity_reached_at = NOW(),
            best_speedrun_seconds = LEAST(
              COALESCE(best_speedrun_seconds, 999999999),
              EXTRACT(EPOCH FROM (NOW() - COALESCE(speedrun_run_start, created_at)))
            )
          WHERE discord_id = $1
            AND (infinity_reached_at IS NULL OR infinity_reached_at < COALESCE(speedrun_run_start, created_at))
          RETURNING best_speedrun_seconds
        `, [discordId]);
        if (result.rowCount > 0) {
          logger.info('Speedrun recorded', { discordId, seconds: result.rows[0].best_speedrun_seconds });
        }
      }
    } catch (e) {
      // Non-blocking — don't fail the score update for milestone tracking
      logger.error('Error recording speedrun', { error: e.message, discordId });
    }

    // For gambling wins, also update cycleEarnings + lifetimeEarnings in game_state JSONB
    // so prestige progress reflects bot gambling income
    if (isGambling && Number(delta) > 0) {
      try {
        await pool.query(`
          UPDATE scores SET game_state = jsonb_set(
            jsonb_set(
              COALESCE(game_state, '{}'::jsonb),
              '{cycleEarnings}',
              to_jsonb(COALESCE((game_state->>'cycleEarnings')::numeric, 0) + $1::numeric)
            ),
            '{lifetimeEarnings}',
            to_jsonb(COALESCE((game_state->>'lifetimeEarnings')::numeric, 0) + $1::numeric)
          )
          WHERE discord_id = $2 AND game_state IS NOT NULL
        `, [delta, discordId]);
      } catch (e) {
        logger.error('Error updating cycleEarnings for gambling', { error: e.message, discordId });
      }
    }

    logger.info('Score updated', { discordId, delta, newScore: row.score });
    return row;
  } catch (error) {
    logger.error('Error updating score', { error: error.message, discordId });
    throw new InternalError('Failed to update score');
  }
};

/**
 * Get top scores (leaderboard)
 * @param {number} limit - Number of scores to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} Array of score records
 */
const getTopScores = async (limit = 50, offset = 0) => {
  try {
    const query = `
      SELECT
        discord_id,
        username,
        avatar_url,
        score,
        game_state,
        updated_at
      FROM scores
      WHERE score > 0
        AND COALESCE((game_state->>'totalClicks')::int, 0) > 0
        AND discord_id != '000000000000000001'
      ORDER BY score DESC,
        COALESCE((game_state->>'ascensionLevel')::int, 0) DESC,
        updated_at ASC
      LIMIT $1 OFFSET $2;
    `;

    const result = await pool.query(query, [limit, offset]);
    logger.info('Top scores retrieved', { count: result.rows.length, limit, offset });
    return result.rows;
  } catch (error) {
    logger.error('Error fetching top scores', { error: error.message });
    throw new InternalError('Failed to fetch leaderboard');
  }
};

/**
 * Get a user's score by Discord ID
 * @param {string} discordId - Discord user ID
 * @returns {Promise<Object|null>} Score record or null if not found
 */
const getScoreByDiscordId = async (discordId) => {
  try {
    const query = `
      SELECT
        discord_id,
        username,
        avatar_url,
        score,
        game_state,
        created_at,
        updated_at
      FROM scores
      WHERE discord_id = $1;
    `;

    const result = await pool.query(query, [discordId]);

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    logger.error('Error fetching score by Discord ID', { error: error.message, discordId });
    throw new InternalError('Failed to fetch score');
  }
};

/**
 * Get user's rank on the leaderboard
 * @param {string} discordId - Discord user ID
 * @returns {Promise<number|null>} Rank (1-indexed) or null if not found
 */
const getUserRank = async (discordId) => {
  try {
    const query = `
      WITH ranked_scores AS (
        SELECT
          discord_id,
          RANK() OVER (ORDER BY score DESC, COALESCE((game_state->>'ascensionLevel')::int, 0) DESC, updated_at ASC) as rank
        FROM scores
        WHERE discord_id != '000000000000000001'
      )
      SELECT rank
      FROM ranked_scores
      WHERE discord_id = $1;
    `;

    const result = await pool.query(query, [discordId]);

    if (result.rows.length === 0) {
      return null;
    }

    return parseInt(result.rows[0].rank);
  } catch (error) {
    logger.error('Error fetching user rank', { error: error.message, discordId });
    throw new InternalError('Failed to fetch user rank');
  }
};

/**
 * Get total number of scores
 * @returns {Promise<number>} Total count
 */
const getTotalScoresCount = async () => {
  try {
    const query = 'SELECT COUNT(*) as count FROM scores;';
    const result = await pool.query(query);
    return parseInt(result.rows[0].count);
  } catch (error) {
    logger.error('Error fetching total scores count', { error: error.message });
    throw new InternalError('Failed to fetch scores count');
  }
};

/**
 * Get top scores with time period filter
 * @param {string} period - Time period: 'daily', 'weekly', 'monthly', 'all'
 * @param {number} limit - Number of scores to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} Array of score records
 */
const getTopScoresByPeriod = async (period = 'all', limit = 50, offset = 0) => {
  try {
    let timeFilter = '';

    if (period === 'daily') {
      timeFilter = "AND updated_at >= NOW() - INTERVAL '1 day'";
    } else if (period === 'weekly') {
      timeFilter = "AND updated_at >= NOW() - INTERVAL '7 days'";
    } else if (period === 'monthly') {
      timeFilter = "AND updated_at >= NOW() - INTERVAL '30 days'";
    }
    // 'all' has no time filter

    const query = `
      SELECT
        discord_id,
        username,
        avatar_url,
        score,
        game_state,
        created_at,
        updated_at
      FROM scores
      WHERE score > 0
        AND COALESCE((game_state->>'totalClicks')::int, 0) > 0
        AND discord_id != '000000000000000001'
        ${timeFilter}
      ORDER BY score DESC,
        COALESCE((game_state->>'ascensionLevel')::int, 0) DESC,
        updated_at ASC
      LIMIT $1 OFFSET $2;
    `;

    const result = await pool.query(query, [limit, offset]);
    logger.info('Top scores retrieved by period', { count: result.rows.length, period, limit, offset });
    return result.rows;
  } catch (error) {
    logger.error('Error fetching top scores by period', { error: error.message, period });
    throw new InternalError('Failed to fetch leaderboard');
  }
};

/**
 * Get a user's score and game state
 * @param {string} discordId - Discord user ID
 * @returns {Promise<Object|null>} { score, game_state } or null
 */
const getGameState = async (discordId) => {
  try {
    const query = `
      SELECT score, game_state
      FROM scores
      WHERE discord_id = $1;
    `;
    const result = await pool.query(query, [discordId]);
    if (result.rows.length === 0) return null;
    return result.rows[0];
  } catch (error) {
    logger.error('Error fetching game state', { error: error.message, discordId });
    throw new InternalError('Failed to fetch game state');
  }
};

/**
 * Save a user's game state
 * @param {string} discordId - Discord user ID
 * @param {Object} gameState - Game state JSON
 * @returns {Promise<Object>} Updated row
 */
const saveGameState = async (discordId, gameState, score) => {
  try {
    const hasScore = score !== undefined && score !== null
    const query = hasScore
      ? `UPDATE scores
         SET game_state = $1,
             score = CASE
               WHEN $3::NUMERIC = 0 THEN LEAST(0::NUMERIC, scores.score)
               ELSE LEAST(${SCORE_CAP}::NUMERIC, $3::NUMERIC)
             END,
             speedrun_run_start = CASE WHEN $3::NUMERIC = 0 THEN NOW() ELSE speedrun_run_start END,
             updated_at = NOW()
         WHERE discord_id = $2
         RETURNING score, game_state;`
      : `UPDATE scores
         SET game_state = $1, updated_at = NOW()
         WHERE discord_id = $2
         RETURNING score, game_state;`;
    const values = hasScore
      ? [JSON.stringify(gameState), discordId, score]
      : [JSON.stringify(gameState), discordId]
    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      throw new NotFoundError('User score record not found');
    }
    logger.info('Game state saved', { discordId, scoreReset: hasScore });
    return result.rows[0];
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    logger.error('Error saving game state', { error: error.message, discordId });
    throw new InternalError('Failed to save game state');
  }
};

/**
 * Get speedrun leaderboard — fastest best run time to infinity
 * @param {number} limit - Number of entries to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} Array of speedrun entries
 */
const getSpeedrunLeaderboard = async (limit = 50, offset = 0) => {
  try {
    const query = `
      SELECT
        discord_id,
        username,
        avatar_url,
        score,
        game_state,
        best_speedrun_seconds
      FROM scores
      WHERE best_speedrun_seconds IS NOT NULL
      ORDER BY best_speedrun_seconds ASC
      LIMIT $1 OFFSET $2;
    `;
    const result = await pool.query(query, [limit, offset]);
    return result.rows;
  } catch (error) {
    logger.error('Error fetching speedrun leaderboard', { error: error.message });
    throw new InternalError('Failed to fetch speedrun leaderboard');
  }
};

/**
 * Get ascension leaderboard — highest ascension levels
 * @param {number} limit - Number of entries to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} Array of ascension entries
 */
const getAscensionLeaderboard = async (limit = 15, offset = 0) => {
  try {
    const query = `
      SELECT
        discord_id,
        username,
        avatar_url,
        score,
        game_state
      FROM scores
      WHERE (game_state->>'ascensionLevel')::int > 0
      ORDER BY (game_state->>'ascensionLevel')::int DESC, score DESC
      LIMIT $1 OFFSET $2;
    `;
    const result = await pool.query(query, [limit, offset]);
    return result.rows;
  } catch (error) {
    logger.error('Error fetching ascension leaderboard', { error: error.message });
    throw new InternalError('Failed to fetch ascension leaderboard');
  }
};

/**
 * Atomically donate a user's entire balance, setting score to 0
 * @param {string} discordId - Discord user ID
 * @returns {Promise<string|null>} Donated amount as string, or null if nothing to donate
 */
const donateBalance = async (discordId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT score FROM scores WHERE discord_id = $1 FOR UPDATE',
      [discordId]
    );
    if (!rows[0] || BigInt(rows[0].score) <= 0n) {
      await client.query('ROLLBACK');
      return null;
    }
    const donatedAmount = rows[0].score;
    await client.query(
      'UPDATE scores SET score = 0, updated_at = NOW() WHERE discord_id = $1',
      [discordId]
    );
    await client.query('COMMIT');
    logger.info('Balance donated to lottery', { discordId, amount: donatedAmount });
    return donatedAmount;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error donating balance', { error: error.message, discordId });
    throw new InternalError('Failed to donate balance');
  } finally {
    client.release();
  }
};

/**
 * Get gambling leaderboard — net gambling profit/loss
 * @param {number} limit - Number of entries to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} Array of gambling entries sorted by net descending
 */
const getGamblingLeaderboard = async (limit = 50, offset = 0) => {
  try {
    const query = `
      SELECT
        discord_id,
        username,
        avatar_url,
        score,
        gambling_net
      FROM scores
      WHERE gambling_net != 0
      ORDER BY gambling_net DESC
      LIMIT $1 OFFSET $2;
    `;
    const result = await pool.query(query, [limit, offset]);
    return result.rows;
  } catch (error) {
    logger.error('Error fetching gambling leaderboard', { error: error.message });
    throw new InternalError('Failed to fetch gambling leaderboard');
  }
};

module.exports = {
  addToScore,
  getTopScores,
  getTopScoresByPeriod,
  getScoreByDiscordId,
  getUserRank,
  getTotalScoresCount,
  getGameState,
  saveGameState,
  getSpeedrunLeaderboard,
  getAscensionLeaderboard,
  getGamblingLeaderboard,
  donateBalance
};

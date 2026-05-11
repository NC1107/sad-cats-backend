const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');

const DEFAULT_TTL = 300; // 5 minutes

/**
 * Get cached data or compute if missing
 */
const getOrCompute = async (key, computeFn, ttl = DEFAULT_TTL) => {
  try {
    // Try to get from cache
    const cached = await redisClient.get(key);
    if (cached) {
      logger.debug('Cache hit', { key });
      return JSON.parse(cached);
    }

    // Cache miss - compute value
    logger.debug('Cache miss', { key });
    const value = computeFn(); // Synchronous function for better-sqlite3

    // Store in cache
    await redisClient.setEx(key, ttl, JSON.stringify(value));

    return value;
  } catch (error) {
    logger.error('Cache error, falling back to direct computation', {
      error: error.message,
      key
    });
    // Fallback: just compute without caching
    return computeFn();
  }
};

/**
 * Invalidate cache by key pattern.
 *
 * Uses SCAN (non-blocking, cursor-paged) instead of KEYS, which blocks the entire
 * Redis event loop until the full keyspace is walked. This matters because
 * `invalidate('scores:leaderboard:*')` fires on every prestige/ascension/score save —
 * with thousands of keys, KEYS stalls every other Redis op during the scan.
 *
 * @param {string} pattern Redis glob (e.g. 'scores:leaderboard:*'). Exact keys
 *   (no wildcard) are deleted directly without scanning.
 */
const invalidate = async (pattern) => {
  try {
    // Fast path for exact keys.
    if (!/[*?[\]]/.test(pattern)) {
      const deleted = await redisClient.del(pattern);
      if (deleted > 0) logger.info('Cache invalidated', { pattern, count: deleted });
      return;
    }

    // Non-blocking scan loop. node-redis v4 returns { cursor, keys } per iteration.
    let cursor = '0';
    let total = 0;
    do {
      const reply = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 200 });
      cursor = typeof reply === 'object' && reply !== null ? String(reply.cursor) : String(reply[0]);
      const keys = Array.isArray(reply.keys) ? reply.keys : reply[1];
      if (keys && keys.length > 0) {
        await redisClient.del(keys);
        total += keys.length;
      }
    } while (cursor !== '0');

    if (total > 0) logger.info('Cache invalidated', { pattern, count: total });
  } catch (error) {
    logger.error('Cache invalidation error', { error: error.message, pattern });
  }
};

module.exports = {
  getOrCompute,
  invalidate
};

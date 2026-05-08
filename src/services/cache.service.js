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
 * Invalidate cache by key pattern
 */
const invalidate = async (pattern) => {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
      logger.info('Cache invalidated', { pattern, count: keys.length });
    }
  } catch (error) {
    logger.error('Cache invalidation error', { error: error.message, pattern });
  }
};

module.exports = {
  getOrCompute,
  invalidate
};

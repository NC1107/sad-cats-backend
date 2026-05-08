const express = require('express');
const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Health check endpoint
 */
router.get('/', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
    database: 'unknown',
    redis: 'unknown'
  };

  try {
    // Check database connection
    await pool.query('SELECT 1');
    health.database = 'connected';
  } catch (error) {
    health.database = 'disconnected';
    health.status = 'degraded';
    logger.error('Database health check failed', { error: error.message });
  }

  try {
    // Check Redis connection
    await redisClient.ping();
    health.redis = 'connected';
  } catch (error) {
    health.redis = 'disconnected';
    health.status = 'degraded';
    logger.error('Redis health check failed', { error: error.message });
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Public feature flags endpoint (no auth required)
 */
router.get('/flags', async (req, res) => {
  try {
    const [adReroll, bossSpawning, robCmd, giveCmd, duelCmd, lotteryCmd] = await Promise.all([
      redisClient.get('config:adRerollEnabled'),
      redisClient.get('config:bossSpawningEnabled'),
      redisClient.get('config:robCommandEnabled'),
      redisClient.get('config:giveCommandEnabled'),
      redisClient.get('config:duelCommandEnabled'),
      redisClient.get('config:lotteryCommandEnabled')
    ]);
    res.json({
      adRerollEnabled: adReroll === 'true',
      bossSpawningEnabled: bossSpawning !== 'false',
      robCommandEnabled: robCmd !== 'false',
      giveCommandEnabled: giveCmd !== 'false',
      duelCommandEnabled: duelCmd !== 'false',
      lotteryCommandEnabled: lotteryCmd !== 'false'
    });
  } catch (error) {
    logger.error('Failed to fetch flags', { error: error.message });
    res.json({ adRerollEnabled: false, bossSpawningEnabled: true, robCommandEnabled: true, giveCommandEnabled: true, duelCommandEnabled: true, lotteryCommandEnabled: true });
  }
});

module.exports = router;

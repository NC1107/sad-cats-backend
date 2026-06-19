const express = require('express');
const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');
const { version } = require('../../package.json');

const router = express.Router();

// Build provenance — GIT_SHA / BUILD_TIME are injected at image build time
// (Dockerfile ARG → ENV, set by the GitHub Actions build). They fall back
// gracefully for local/dev runs where they aren't set.
const COMMIT = process.env.GIT_SHA || 'dev';
const BUILD_TIME = process.env.BUILD_TIME || 'dev';
const STARTED_AT = new Date().toISOString();

/**
 * Health check endpoint. Cheap — also carries version/commit so the frontend can
 * tell which build is live without an extra round-trip.
 */
router.get('/', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
    version,
    commit: COMMIT,
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
 * Version / build-provenance endpoint (no auth). Lets the frontend (or anyone)
 * confirm exactly which build is live and which DB migrations have been applied —
 * the direct way to verify a deploy + migration actually rolled out.
 */
router.get('/version', async (req, res) => {
  const out = {
    name: 'sad-cats-backend',
    version,
    commit: COMMIT,
    buildTime: BUILD_TIME,
    startedAt: STARTED_AT,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    environment: process.env.NODE_ENV || 'unknown',
    migrations: { latest: null, count: 0 }
  };

  try {
    // schema_migrations is created by the migration runner on first boot; tolerate
    // its absence (brand-new DB) rather than 500ing the version check.
    const { rows } = await pool.query(
      `SELECT filename FROM schema_migrations ORDER BY filename DESC`
    );
    out.migrations.count = rows.length;
    out.migrations.latest = rows[0]?.filename || null;
  } catch (error) {
    out.migrations.error = 'unavailable';
    logger.warn('Version check: could not read schema_migrations', { error: error.message });
  }

  res.json(out);
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

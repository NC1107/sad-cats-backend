const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const { redisClient } = require('../config/redis');
const { recordAnomaly } = require('../services/score-validation.service');

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000; // 1 minute
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 120;

/**
 * General API rate limiter
 */
const apiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  message: {
    success: false,
    error: 'Too many requests, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(429).json({
      success: false,
      error: 'Too many requests, please try again later'
    });
  }
});

/**
 * Strict rate limiter for auth endpoints
 */
const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10, // 10 requests per minute
  message: {
    success: false,
    error: 'Too many authentication attempts, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Auth rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(429).json({
      success: false,
      error: 'Too many authentication attempts, please try again later'
    });
  }
});

/**
 * Rate limiter for score updates
 */
const scoreUpdateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 300, // 300 requests per minute (supports multi-tab + frequent sync)
  message: {
    success: false,
    error: 'Too many score updates, please slow down'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit per user (from JWT)
    return req.user?.data?.discordId || req.ip;
  },
  handler: (req, res) => {
    logger.warn('Score update rate limit exceeded', {
      ip: req.ip,
      discordId: req.user?.data?.discordId
    });
    res.status(429).json({
      success: false,
      error: 'Too many score updates, please slow down'
    });
  }
});

/**
 * Tight rate limiter for bot endpoints that mutate state in destructive ways
 * (e.g. /claim-web-donations resets a counter — spam zeroes pending claims).
 * Keyed by IP since botAuthenticated requests don't set req.user.
 */
const botMutationLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30, // 30/min — generous for legitimate bot batches, tight enough to detect runaway loops
  message: {
    success: false,
    error: 'Too many bot mutations, please slow down'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Bot mutation rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(429).json({
      success: false,
      error: 'Too many bot mutations, please slow down'
    });
  }
});

/**
 * Delta-size token-bucket limiter for /scores/add (anti-cheat Phase 1).
 *
 * The existing scoreUpdateLimiter caps *requests* per minute (300). That stops
 * spam but not a "carpet bomb 50 valid-looking large deltas per minute" attack
 * — a cheater can stay under 300 req/min while pushing 1e25 each call.
 *
 * This limiter charges proportional to log10(delta) so large deltas burn the
 * bucket faster:
 *
 *   cost = floor(log10(max(1, delta)) * 1e15)
 *   budget = 1e18 tokens / minute / user
 *
 * Reasonable legitimate magnitudes:
 *   delta 1e6  → cost 6e15  → ~166 such requests/min before throttle
 *   delta 1e15 → cost 15e15 → ~66 such requests/min
 *   delta 1e25 → cost 25e15 → ~40 such requests/min
 *
 * Fails open if Redis is unavailable (don't 503 legitimate users for a
 * monitoring gap). Anomaly recorded on 429.
 */
const DELTA_BUDGET = 1e18;
const DELTA_BUDGET_WINDOW_S = 60;

const deltaSizeLimiter = async (req, res, next) => {
  try {
    const userId = req.user?.data?.discordId || req.body?.discordId || req.ip;
    if (!userId) return next();
    const delta = Number(req.body?.delta) || 0;
    if (delta <= 0) return next();          // free for refunds / negative bot adjustments

    const cost = Math.floor(Math.log10(Math.max(1, delta)) * 1e15);
    const key = `delta_budget:${userId}`;

    // INCRBY returns the post-increment total. If we're the first writer in the
    // window we also have to set TTL — EXPIRE on a non-existent key is a no-op,
    // so we use SET-NX-EX semantics via a small Lua-free dance: INCRBY then
    // EXPIRE-NX-if-this-is-first.
    const total = await redisClient.incrBy(key, cost);
    if (total === cost) {
      // First touch in this window — set TTL.
      await redisClient.expire(key, DELTA_BUDGET_WINDOW_S);
    }

    if (total > DELTA_BUDGET) {
      recordAnomaly(userId, 'delta_budget_exceeded', {
        delta,
        severity: 'hard',
        payload: { budgetUsed: total, budget: DELTA_BUDGET, cost },
      });
      return res.status(429).json({
        success: false,
        error: 'Score sync budget exceeded — please wait a moment'
      });
    }
    next();
  } catch (e) {
    // Fail open. The budget is a defense-in-depth gate, not the primary
    // anti-cheat surface — losing it briefly is preferable to 503-ing real
    // users on a Redis blip.
    logger.warn('deltaSizeLimiter fail-open', { error: e.message });
    next();
  }
};

module.exports = {
  apiLimiter,
  authLimiter,
  scoreUpdateLimiter,
  botMutationLimiter,
  deltaSizeLimiter
};

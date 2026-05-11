const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

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

module.exports = {
  apiLimiter,
  authLimiter,
  scoreUpdateLimiter,
  botMutationLimiter
};

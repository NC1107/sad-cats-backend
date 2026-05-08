const { verifyToken } = require('../services/jwt.service');
const { AuthenticationError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Middleware to verify JWT token and attach user to request
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // Try Authorization header first, then fall back to cookie (Safari ITP workaround)
    let token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    } else if (req.cookies && req.cookies.auth_token) {
      token = req.cookies.auth_token;
    }

    if (!token) {
      throw new AuthenticationError('No token provided');
    }

    // Verify token and get user data
    const decoded = await verifyToken(token);

    // Attach user data to request
    req.user = decoded;

    logger.debug('User authenticated', { discordId: decoded.sub });

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Optional authentication middleware (doesn't fail if no token)
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    let token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    } else if (req.cookies && req.cookies.auth_token) {
      token = req.cookies.auth_token;
    }

    if (token) {
      const decoded = await verifyToken(token);
      req.user = decoded;
    }

    next();
  } catch (error) {
    // Continue without authentication
    next();
  }
};

/**
 * Require either a valid JWT or the bot API secret header.
 * Unauthenticated requests without the secret are rejected.
 */
const botOrAuth = async (req, res, next) => {
  const botSecret = req.headers['x-bot-secret'];
  if (botSecret && botSecret === process.env.BOT_API_SECRET) {
    req.botAuthenticated = true;
    return next();
  }

  try {
    const authHeader = req.headers.authorization;
    let token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    } else if (req.cookies && req.cookies.auth_token) {
      token = req.cookies.auth_token;
    }

    if (token) {
      const decoded = await verifyToken(token);
      req.user = decoded;
      return next();
    }

    throw new AuthenticationError('Authentication required');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  authenticate,
  optionalAuth,
  botOrAuth
};

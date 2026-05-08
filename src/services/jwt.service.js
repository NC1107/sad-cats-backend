const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');
const { AuthenticationError } = require('../utils/errors');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const JWT_ALGORITHM = process.env.JWT_ALGORITHM || 'HS256';

/**
 * Generate a JWT token for a user
 * @param {Object} userData - User data to include in token
 * @returns {string} JWT token
 */
const generateToken = (userData) => {
  const jti = uuidv4(); // Unique token ID for blacklisting

  const payload = {
    jti,
    sub: userData.discordId,
    data: {
      userId: userData.userId,
      discordId: userData.discordId,
      username: userData.username,
      avatarUrl: userData.avatarUrl,
      isMember: userData.isMember
    }
  };

  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    algorithm: JWT_ALGORITHM
  });

  logger.info('JWT token generated', { discordId: userData.discordId, jti });
  return token;
};

/**
 * Verify and decode a JWT token
 * @param {string} token - JWT token to verify
 * @returns {Object} Decoded token payload
 * @throws {AuthenticationError} If token is invalid or blacklisted
 */
const verifyToken = async (token) => {
  try {
    // Verify JWT signature and expiration
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM]
    });

    // Check if token is blacklisted
    const isBlacklisted = await isTokenBlacklisted(decoded.jti);
    if (isBlacklisted) {
      throw new AuthenticationError('Token has been revoked');
    }

    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AuthenticationError('Token has expired');
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new AuthenticationError('Invalid token');
    }
    throw error;
  }
};

/**
 * Blacklist a token (logout)
 * @param {string} token - JWT token to blacklist
 */
const blacklistToken = async (token) => {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.jti || !decoded.exp) {
      logger.warn('Attempted to blacklist invalid token');
      return;
    }

    const jti = decoded.jti;
    const expiresAt = decoded.exp;
    const now = Math.floor(Date.now() / 1000);
    const ttl = expiresAt - now;

    if (ttl > 0) {
      // Store in Redis with TTL matching token expiration
      await redisClient.setEx(`blacklist:${jti}`, ttl, '1');
      logger.info('Token blacklisted', { jti, ttl });
    }
  } catch (error) {
    logger.error('Error blacklisting token', { error: error.message });
    throw error;
  }
};

/**
 * Check if a token is blacklisted
 * @param {string} jti - Token ID to check
 * @returns {boolean} True if blacklisted
 */
const isTokenBlacklisted = async (jti) => {
  try {
    const result = await redisClient.get(`blacklist:${jti}`);
    return result !== null;
  } catch (error) {
    // Fail open — better to allow potentially-revoked tokens briefly than lock out ALL users
    logger.error('Redis blacklist check failed — failing open', { error: error.message });
    return false;
  }
};

module.exports = {
  generateToken,
  verifyToken,
  blacklistToken,
  isTokenBlacklisted
};

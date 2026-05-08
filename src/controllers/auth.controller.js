const { v4: uuidv4 } = require('uuid');
const { generateToken } = require('../services/jwt.service');
const { verifyGuildMembership } = require('../services/discord.service');
const { blacklistToken } = require('../services/jwt.service');
const logger = require('../utils/logger');
const { AuthenticationError } = require('../utils/errors');

/**
 * Initiate Discord OAuth flow
 */
const initiateOAuth = (req, res) => {
  const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_CALLBACK_URL)}&response_type=code&scope=identify%20guilds`;

  res.json({ authUrl });
};

/**
 * Handle Discord OAuth callback
 */
const handleCallback = async (req, res, next) => {
  try {
    // Passport adds user data to req.user
    if (!req.user) {
      throw new AuthenticationError('OAuth authentication failed');
    }

    const { discordId, username, avatarUrl, accessToken } = req.user;

    // Verify guild membership (with archive database fallback)
    const isMember = await verifyGuildMembership(accessToken, discordId);

    // Generate UUID for database
    const userId = uuidv4();

    // Generate JWT token
    const token = generateToken({
      userId,
      discordId,
      username,
      avatarUrl,
      isMember
    });

    logger.info('User authenticated successfully', { discordId, isMember });

    // Redirect to frontend with token in URL fragment
    const frontendUrl = process.env.CORS_ORIGIN || 'https://sad-cats.org';
    const userData = encodeURIComponent(JSON.stringify({
      userId,
      discordId,
      username,
      avatarUrl,
      isMember
    }));

    // Set auth cookie (reliable on mobile Safari where localStorage can be wiped by ITP)
    res.cookie('auth_token', token, {
      domain: '.sad-cats.org',
      path: '/',
      httpOnly: false,  // Frontend JS needs to read it
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
    });

    res.redirect(`${frontendUrl}/auth/callback?token=${token}&user=${userData}`);
  } catch (error) {
    // Redirect to frontend with error
    const frontendUrl = process.env.CORS_ORIGIN || 'https://sad-cats.org';
    res.redirect(`${frontendUrl}/auth/callback?error=${encodeURIComponent(error.message)}`);
  }
};

/**
 * Get current user info from JWT
 */
const getMe = async (req, res, next) => {
  try {
    // req.user is set by auth middleware
    res.json({
      success: true,
      user: req.user
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Logout (blacklist token)
 */
const logout = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      await blacklistToken(token);
    }

    // Clear auth cookie
    res.clearCookie('auth_token', {
      domain: '.sad-cats.org',
      path: '/'
    });

    logger.info('User logged out', { discordId: req.user?.discordId });

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Refresh token — issue a new JWT, blacklist the old one
 */
const refreshToken = async (req, res, next) => {
  try {
    const oldToken = req.headers.authorization?.replace('Bearer ', '') ||
                     (req.cookies && req.cookies.auth_token);

    if (!oldToken) {
      throw new AuthenticationError('No token to refresh');
    }

    // req.user already verified by auth middleware
    const userData = req.user.data;

    // Blacklist old token
    await blacklistToken(oldToken);

    // Generate fresh token
    const newToken = generateToken({
      userId: userData.userId,
      discordId: userData.discordId,
      username: userData.username,
      avatarUrl: userData.avatarUrl,
      isMember: userData.isMember
    });

    // Update cookie
    res.cookie('auth_token', newToken, {
      domain: '.sad-cats.org',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    logger.info('Token refreshed', { discordId: userData.discordId });

    res.json({
      success: true,
      token: newToken
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  initiateOAuth,
  handleCallback,
  getMe,
  logout,
  refreshToken
};

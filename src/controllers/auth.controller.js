const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Cookie domain lives in env (with the prod default) so a staging deploy or local
// host-mapped run doesn't have to fork this file. validateEnv() at boot accepts
// COOKIE_DOMAIN as optional; we read it lazily so the variable is settable per-test.
const COOKIE_DOMAIN = () => process.env.COOKIE_DOMAIN || '.sad-cats.org';
const { generateToken } = require('../services/jwt.service');
const { verifyGuildMembership } = require('../services/discord.service');
const { blacklistToken } = require('../services/jwt.service');
const { buildDiscordAuthUrl } = require('../utils/oauth');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');
const { AuthenticationError } = require('../utils/errors');

const SESSION_PICKUP_TTL_SECONDS = 60;
const SESSION_PICKUP_PREFIX = 'oauth:pickup:';

/**
 * Initiate Discord OAuth flow (legacy JSON endpoint — the live frontend uses /login).
 */
const initiateOAuth = (req, res) => {
  res.json({ authUrl: buildDiscordAuthUrl() });
};

/**
 * Handle Discord OAuth callback.
 *
 * Issue #7 fix: the JWT no longer travels in the redirect URL. Instead we store
 * `{ token, user }` in Redis under a one-time pickup code (UUID), redirect with
 * `?session=<code>` only, and the frontend exchanges that code for the actual
 * token via POST /api/auth/session/:code. The pickup entry self-destructs on
 * pickup or after SESSION_PICKUP_TTL_SECONDS.
 *
 * The cookie still gets set (httpOnly + secure now) so all subsequent HTTP
 * requests authenticate via the cookie alone. The token returned from session
 * pickup is only consumed by the socket client (handshake auth needs a token).
 */
const handleCallback = async (req, res, next) => {
  const frontendUrl = process.env.CORS_ORIGIN || 'https://sad-cats.org';
  try {
    if (!req.user) {
      throw new AuthenticationError('OAuth authentication failed');
    }

    const { discordId, username, avatarUrl, accessToken } = req.user;
    const isMember = await verifyGuildMembership(accessToken, discordId);
    const userId = uuidv4();
    const token = generateToken({ userId, discordId, username, avatarUrl, isMember });

    logger.info('User authenticated successfully', { discordId, isMember });

    // httpOnly auth cookie — the primary session source of truth for HTTP requests.
    // Was httpOnly:false before (issue #9); flipping it required closing the URL
    // token leak first because the frontend needed an in-band way to get the JWT
    // for socket auth.
    res.cookie('auth_token', token, {
      domain: COOKIE_DOMAIN(),
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
    });

    // One-time session pickup: stash the token + user payload in Redis under a
    // random opaque code, then redirect with only that code in the URL.
    const sessionCode = uuidv4();
    const payload = JSON.stringify({
      token,
      user: { userId, discordId, username, avatarUrl, isMember }
    });
    await redisClient.setEx(SESSION_PICKUP_PREFIX + sessionCode, SESSION_PICKUP_TTL_SECONDS, payload);

    res.redirect(`${frontendUrl}/auth/callback?session=${sessionCode}`);
  } catch (error) {
    // Don't echo error.message — could leak internals. Log server-side, surface a
    // generic code the frontend translates to a user-friendly message.
    logger.warn('OAuth callback failed', { error: error.message });
    res.redirect(`${frontendUrl}/auth/callback?error=oauth_failed`);
  }
};

/**
 * Exchange a one-time pickup code for the JWT + user payload stashed at the
 * end of the OAuth flow. Code is consumed (deleted) on success — no replay.
 */
const sessionPickup = async (req, res, next) => {
  try {
    const code = req.params.code;
    if (!code || !/^[a-f0-9-]{36}$/i.test(code)) {
      return res.status(400).json({ error: 'Invalid session code' });
    }
    const key = SESSION_PICKUP_PREFIX + code;
    const payload = await redisClient.get(key);
    if (!payload) {
      return res.status(404).json({ error: 'Session expired or already claimed' });
    }
    // Single-use: delete immediately so a leak of the code (e.g. via browser history
    // before the redirect lands) can't be replayed by a second tab.
    await redisClient.del(key);
    res.json(JSON.parse(payload));
  } catch (error) {
    next(error);
  }
};

/**
 * Validate that the OAuth `state` query param matches the cookie set at /login.
 * Express middleware — runs before passport on /callback.
 *
 * Constant-time comparison even though state is opaque; cheap to do correctly.
 */
const verifyOauthState = (req, res, next) => {
  const frontendUrl = process.env.CORS_ORIGIN || 'https://sad-cats.org';
  const queryState = req.query.state;
  const cookieState = req.cookies?.oauth_state;
  res.clearCookie('oauth_state', { domain: COOKIE_DOMAIN(), path: '/' });

  if (!queryState || !cookieState) {
    logger.warn('OAuth state missing', { hasQuery: !!queryState, hasCookie: !!cookieState });
    return res.redirect(`${frontendUrl}/auth/callback?error=oauth_state_missing`);
  }
  const q = Buffer.from(String(queryState));
  const c = Buffer.from(String(cookieState));
  if (q.length !== c.length || !crypto.timingSafeEqual(q, c)) {
    logger.warn('OAuth state mismatch — possible CSRF', { ip: req.ip });
    return res.redirect(`${frontendUrl}/auth/callback?error=oauth_state_mismatch`);
  }
  next();
};

/**
 * Get current user info from JWT (middleware already validated).
 */
const getMe = async (req, res, next) => {
  try {
    res.json({ success: true, user: req.user });
  } catch (error) {
    next(error);
  }
};

/**
 * Logout (blacklist token)
 */
const logout = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.auth_token;
    if (token) {
      await blacklistToken(token);
    }
    res.clearCookie('auth_token', { domain: COOKIE_DOMAIN(), path: '/' });
    logger.info('User logged out', { discordId: req.user?.discordId });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * Refresh token — issue a new JWT, blacklist the old one. Cookie updated;
 * the new JWT is also returned in the body for the socket client to consume.
 */
const refreshToken = async (req, res, next) => {
  try {
    const oldToken = req.headers.authorization?.replace('Bearer ', '') ||
                     (req.cookies && req.cookies.auth_token);
    if (!oldToken) {
      throw new AuthenticationError('No token to refresh');
    }
    const userData = req.user.data;
    await blacklistToken(oldToken);
    const newToken = generateToken({
      userId: userData.userId,
      discordId: userData.discordId,
      username: userData.username,
      avatarUrl: userData.avatarUrl,
      isMember: userData.isMember
    });
    res.cookie('auth_token', newToken, {
      domain: COOKIE_DOMAIN(),
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    logger.info('Token refreshed', { discordId: userData.discordId });
    res.json({ success: true, token: newToken });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  initiateOAuth,
  handleCallback,
  sessionPickup,
  verifyOauthState,
  getMe,
  logout,
  refreshToken
};

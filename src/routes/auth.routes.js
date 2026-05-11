const crypto = require('crypto');
const express = require('express');
const passport = require('../config/passport');
const {
  initiateOAuth,
  handleCallback,
  sessionPickup,
  verifyOauthState,
  getMe,
  logout,
  refreshToken
} = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { buildDiscordAuthUrl } = require('../utils/oauth');
const logger = require('../utils/logger');

const router = express.Router();
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000; // 5 min — covers slow OAuth flows without long replay window

// Initiate Discord OAuth (legacy JSON endpoint; live frontend uses /login redirect)
router.post('/discord', authLimiter, initiateOAuth);

// Server-side redirect to Discord OAuth (prevents app interception on iOS).
// Issue #10 fix: generate a random `state` param + cookie before redirecting.
// /callback verifies the cookie matches what Discord echoes back, defending
// against login-CSRF (attacker tricks user into completing attacker's flow).
router.get('/login', authLimiter, (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('oauth_state', state, {
    domain: '.sad-cats.org',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: OAUTH_STATE_TTL_MS
  });
  res.redirect(buildDiscordAuthUrl({ state }));
});

// OAuth callback — state verification runs before passport so a mismatched
// state never triggers token exchange or DB writes.
router.get('/callback',
  authLimiter,
  verifyOauthState,
  passport.authenticate('discord', { session: false, failureRedirect: '/api/auth/error' }),
  handleCallback
);

// One-time session pickup: frontend POSTs the code from `?session=<uuid>` and
// receives `{ token, user }`. See controllers/auth.controller.js handleCallback
// for the rationale (issue #7 — token used to ride in the redirect URL).
router.post('/session/:code', authLimiter, sessionPickup);

// Get current user
router.get('/me', authenticate, getMe);

// Logout
router.post('/logout', authenticate, logout);

// Refresh token (issue new JWT, blacklist old one)
router.post('/refresh', authenticate, refreshToken);

// OAuth error handler (legacy — passport failureRedirect points here)
router.get('/error', (req, res) => {
  logger.warn('OAuth flow reached /error', { ip: req.ip });
  res.status(401).json({ success: false, error: 'Authentication failed' });
});

module.exports = router;

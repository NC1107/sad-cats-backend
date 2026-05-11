const express = require('express');
const passport = require('../config/passport');
const {
  initiateOAuth,
  handleCallback,
  getMe,
  logout,
  refreshToken
} = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { buildDiscordAuthUrl } = require('../utils/oauth');

const router = express.Router();

// Initiate Discord OAuth (JSON response with URL)
router.post('/discord', authLimiter, initiateOAuth);

// Server-side redirect to Discord OAuth (prevents app interception on iOS).
// URL builder lives in utils/oauth.js — was previously duplicated here + in the
// JSON-response controller (issue #16).
router.get('/login', authLimiter, (req, res) => {
  res.redirect(buildDiscordAuthUrl());
});

// OAuth callback
router.get('/callback',
  authLimiter,
  passport.authenticate('discord', { session: false, failureRedirect: '/api/auth/error' }),
  handleCallback
);

// Get current user
router.get('/me', authenticate, getMe);

// Logout
router.post('/logout', authenticate, logout);

// Refresh token (issue new JWT, blacklist old one)
router.post('/refresh', authenticate, refreshToken);

// OAuth error handler
router.get('/error', (req, res) => {
  res.status(401).json({
    success: false,
    error: 'Authentication failed'
  });
});

module.exports = router;

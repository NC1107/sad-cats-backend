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

const router = express.Router();

// Initiate Discord OAuth (JSON response with URL)
router.post('/discord', authLimiter, initiateOAuth);

// Server-side redirect to Discord OAuth (prevents app interception on iOS)
router.get('/login', authLimiter, (req, res) => {
  const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_CALLBACK_URL)}&response_type=code&scope=identify%20guilds`;
  res.redirect(authUrl);
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

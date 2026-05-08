const express = require('express');
const {
  getUserProfile,
  getAnalyticsLeaderboard,
  getServerAnalytics,
  getRandomAttachmentEndpoint,
  getChannelsEndpoint
} = require('../controllers/analytics.controller');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// All analytics routes require authentication
router.use(authenticate);

// Get user profile analytics
router.get('/user/:discordId', apiLimiter, getUserProfile);

// Get analytics leaderboard
router.get('/leaderboard', apiLimiter, getAnalyticsLeaderboard);

// Get server analytics dashboard
router.get('/server', apiLimiter, getServerAnalytics);

// Get random attachment (image or video) with optional filters
router.get('/random-attachment', apiLimiter, getRandomAttachmentEndpoint);

// Get channels list for filters
router.get('/channels', apiLimiter, getChannelsEndpoint);

module.exports = router;

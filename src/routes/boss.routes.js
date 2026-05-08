const express = require('express');
const { getBoss, getContributors, claimReward, getBuff, voteBossSpawn, getVoteStatus } = require('../controllers/boss.controller');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Get current boss + optional user contribution (public, optionally authenticated)
router.get('/current', optionalAuth, apiLimiter, getBoss);

// Get top contributors (public)
router.get('/contributors', apiLimiter, getContributors);

// Claim reward from defeated boss (requires auth)
router.post('/claim', authenticate, apiLimiter, claimReward);

// Get active boss buff (requires auth)
router.get('/buff', authenticate, apiLimiter, getBuff);

// Vote to spawn a boss (requires auth)
router.post('/vote', authenticate, apiLimiter, voteBossSpawn);

// Get current vote status (optionally authenticated)
router.get('/vote-status', optionalAuth, apiLimiter, getVoteStatus);

module.exports = router;

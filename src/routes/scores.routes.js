const express = require('express');
const {
  addToScore,
  getLeaderboard,
  getUserScore,
  getFullState,
  saveFullState,
  getSpeedrunLeaderboard,
  getAscensionLeaderboard,
  getGamblingLeaderboard,
  claimWebDonations
} = require('../controllers/scores.controller');
const { authenticate, botOrAuth } = require('../middleware/auth');
const { scoreUpdateLimiter, apiLimiter, botMutationLimiter } = require('../middleware/rateLimiter');
const { validateRequest } = require('../middleware/validateRequest');
const { addScoreSchema, getLeaderboardSchema, gameStateSchema } = require('../validators/score.validator');

const router = express.Router();

// Atomically add to/subtract from score (requires JWT or bot secret)
router.post('/add',
  botOrAuth,
  scoreUpdateLimiter,
  validateRequest(addScoreSchema),
  addToScore
);

// Get leaderboard (public)
router.get('/leaderboard',
  apiLimiter,
  validateRequest(getLeaderboardSchema),
  getLeaderboard
);

// Get authenticated user's full game state (score + upgrades/prestige/achievements)
router.get('/state',
  authenticate,
  apiLimiter,
  getFullState
);

// Save authenticated user's game state
router.put('/state',
  authenticate,
  apiLimiter,
  validateRequest(gameStateSchema),
  saveFullState
);

// Speedrun leaderboard — best time to infinity (public)
// Must be before /:discordId to avoid param collision
router.get('/leaderboard/speedrun',
  apiLimiter,
  getSpeedrunLeaderboard
);

// Ascension leaderboard — highest ascension levels (public)
router.get('/leaderboard/ascension',
  apiLimiter,
  getAscensionLeaderboard
);

// Gambling leaderboard — net profit/loss (public)
router.get('/leaderboard/gambling',
  apiLimiter,
  getGamblingLeaderboard
);

// Claim pending web donations (bot only). botMutationLimiter caps damage if the
// bot secret leaks — the endpoint zeroes a counter, so spam is destructive.
router.post('/claim-web-donations',
  botOrAuth,
  botMutationLimiter,
  claimWebDonations
);

// Get specific user score (public)
router.get('/:discordId',
  apiLimiter,
  getUserScore
);

module.exports = router;

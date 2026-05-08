const express = require('express');
const { getMyToys } = require('../controllers/inventory.controller');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Get authenticated user's toy inventory
router.get('/toys', authenticate, apiLimiter, getMyToys);

// Legacy alias for old clients
router.get('/shards', authenticate, apiLimiter, getMyToys);

module.exports = router;

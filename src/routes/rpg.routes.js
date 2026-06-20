const express = require('express');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { validateRequest } = require('../middleware/validateRequest');
const { setPartySchema } = require('../validators/rpg.validator');
const { getCats, getParty, setParty } = require('../controllers/rpg.controller');

const router = express.Router();

// All owned cats with derived stats + active party + rosterBonus
router.get('/cats', authenticate, apiLimiter, getCats);

// Active party (lighter than /cats)
router.get('/party', authenticate, apiLimiter, getParty);

// Replace the active party (ownership + no-dup validated server-side)
router.put('/party', authenticate, apiLimiter, validateRequest(setPartySchema), setParty);

module.exports = router;

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const { validateRequest } = require('../middleware/validateRequest');
const { setPartySchema, startCombatSchema, acceptDispatchSchema } = require('../validators/rpg.validator');
const {
  getCats, getParty, setParty, startCombat, getStory,
  getDispatch, acceptDispatch, collectDispatch, getDaily, claimDaily,
  reviveCat, restoreConfidence,
} = require('../controllers/rpg.controller');

const router = express.Router();

// All owned cats with derived stats + active party + rosterBonus
router.get('/cats', authenticate, apiLimiter, getCats);

// Active party (lighter than /cats)
router.get('/party', authenticate, apiLimiter, getParty);

// Replace the active party (ownership + no-dup validated server-side)
router.put('/party', authenticate, apiLimiter, validateRequest(setPartySchema), setParty);

// Story node map + this player's progress
router.get('/story', authenticate, apiLimiter, getStory);

// Resolve a turn-based fight server-side (rewards on first clear)
router.post('/combat/start', authenticate, apiLimiter, validateRequest(startCombatSchema), startCombat);

// Dispatch quests (time-gated idle missions)
router.get('/dispatch', authenticate, apiLimiter, getDispatch);
router.post('/dispatch/accept', authenticate, apiLimiter, validateRequest(acceptDispatchSchema), acceptDispatch);
router.post('/dispatch/:id/collect', authenticate, apiLimiter, collectDispatch);

// Daily cat quests
router.get('/daily', authenticate, apiLimiter, getDaily);
router.post('/daily/:id/claim', authenticate, apiLimiter, claimDaily);

// Combat stakes — revive a downed cat (catnip) / restore lost confidence
router.post('/cats/:id/revive', authenticate, apiLimiter, reviveCat);
router.post('/cats/:id/restore-confidence', authenticate, apiLimiter, restoreConfidence);

module.exports = router;

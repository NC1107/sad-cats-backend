const express = require('express');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');
const {
  combineToys,
  openCase,
  getPlayerCases,
  sellToys,
  sellCard,
  shopBuyCase,
  getMyCards,
  getShop,
  getHistory,
  previewCombine,
  summonBoss,
  getPublicCards,
  shopBuyToy,
  setFavorites,
  getFavorites,
} = require('../controllers/collection.controller');

const router = express.Router();

// Player's card collection + catnip + pity
router.get('/my-cards', authenticate, apiLimiter, getMyCards);

// Player's unopened cases
router.get('/my-cases', authenticate, apiLimiter, getPlayerCases);

// Case opening history
router.get('/history', authenticate, apiLimiter, getHistory);

// Shop info (daily rotating) — optional auth for catnip balance
router.get('/shop', optionalAuth, apiLimiter, getShop);

// Preview combine result without consuming
router.get('/preview-combine', authenticate, apiLimiter, previewCombine);

// Combine 5 toys into a case (goes to inventory)
router.post('/combine', authenticate, apiLimiter, combineToys);

// Open a case from inventory
router.post('/open', authenticate, apiLimiter, openCase);

// Sell toys for catnip
router.post('/sell-toys', authenticate, apiLimiter, sellToys);

// Sell a duplicate card for catnip
router.post('/sell-card', authenticate, apiLimiter, sellCard);

// Buy a case from the daily shop
router.post('/shop/buy', authenticate, apiLimiter, shopBuyCase);

// Summon a random boss (1/day server-wide, costs catnip)
router.post('/shop/summon-boss', authenticate, apiLimiter, summonBoss);

// Buy a toy from the toy shop
router.post('/shop/buy-toy', authenticate, apiLimiter, shopBuyToy);

// Set favorite cats (max 5)
router.put('/favorites', authenticate, apiLimiter, setFavorites);

// Public: get any user's favorite cats
router.get('/favorites/:discordId', apiLimiter, getFavorites);

// Public: view any user's collection by Discord ID
router.get('/cards/:discordId', apiLimiter, getPublicCards);

module.exports = router;

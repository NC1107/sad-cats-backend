const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const { apiLimiter } = require('../middleware/rateLimiter');
const {
  checkAdmin,
  getStats,
  getEnhancedStats,
  listUsers,
  getUser,
  setUserScore,
  resetUserGameState,
  updateUserGameState,
  resetBoss,
  getBossDetails,
  setBossHP,
  defeatBoss,
  spawnBoss,
  getFlags,
  setFlag,
  getDevPresets,
  loadDevPreset,
  getCpsHistory,
  resetAllPlayers,
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  resetInfinityLeaderboard,
  getUserInventory,
  adminGiveToys,
  adminGiveCard,
  adminGiveCatnip,
  adminRemoveToy,
  adminRemoveCard,
  getCardCatalog,
  listAnomalies,
} = require('../controllers/admin.controller');

const router = express.Router();

// All admin routes require authentication + admin check
router.use(authenticate, apiLimiter);

// Lightweight admin check (no requireAdmin — returns isAdmin boolean)
router.get('/check', checkAdmin);

// Everything below requires admin
router.use(requireAdmin);

router.get('/stats', getStats);
router.get('/users', listUsers);
router.get('/users/:discordId', getUser);
router.get('/users/:discordId/cps-history', getCpsHistory);
router.post('/users/:discordId/set-score', setUserScore);
router.post('/users/:discordId/reset-state', resetUserGameState);
router.post('/users/:discordId/update-state', updateUserGameState);
router.post('/users/:discordId/snapshot', createSnapshot);
router.get('/users/:discordId/snapshots', listSnapshots);
router.post('/users/:discordId/restore', restoreSnapshot);
router.get('/boss', getBossDetails);
router.post('/boss/reset', resetBoss);
router.post('/boss/set-hp', setBossHP);
router.post('/boss/defeat', defeatBoss);
router.post('/boss/spawn', spawnBoss);
router.get('/flags', getFlags);
router.post('/flags/:flag/toggle', setFlag);
router.get('/enhanced-stats', getEnhancedStats);
router.get('/dev-presets', getDevPresets);
router.post('/dev-presets/:preset/load', loadDevPreset);
router.post('/reset-all', resetAllPlayers);
router.post('/reset-infinity-leaderboard', resetInfinityLeaderboard);

// Card catalog (for admin dropdowns)
router.get('/cards', getCardCatalog);

// Anti-cheat anomaly readout (Phase 2 of ANTI_CHEAT_PLAN.md)
router.get('/anomalies', listAnomalies);

// Inventory management
router.get('/users/:discordId/inventory', getUserInventory);
router.post('/users/:discordId/give-toys', adminGiveToys);
router.post('/users/:discordId/give-card', adminGiveCard);
router.post('/users/:discordId/give-catnip', adminGiveCatnip);
router.delete('/users/:discordId/remove-toy/:toyId', adminRemoveToy);
router.delete('/users/:discordId/remove-card/:cardId', adminRemoveCard);

module.exports = router;

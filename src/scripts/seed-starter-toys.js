/**
 * One-time script: Give all existing users 5 random starter toys.
 * Idempotent — skips users who already have toys.
 *
 * Run: docker exec sad-cats-api node src/scripts/seed-starter-toys.js
 */

const pool = require('../config/database');
const toyService = require('../services/toy.service');
const inventoryModel = require('../models/inventory.model');
const logger = require('../utils/logger');

async function seedStarterToys() {
  logger.info('Fetching all users from scores table');
  const { rows: users } = await pool.query('SELECT discord_id FROM scores');
  logger.info('Users to evaluate', { count: users.length });

  let seeded = 0;
  let skipped = 0;

  for (const user of users) {
    // Check if user already has toys (idempotent)
    const count = await inventoryModel.getToyCount(user.discord_id);
    if (count > 0) {
      skipped++;
      continue;
    }

    // Generate 5 random toys
    const toys = [];
    for (let i = 0; i < 5; i++) {
      const rarityWeight = Math.floor(Math.random() * 19) + 1; // 1-19
      const toy = toyService.generateToy('Starter Gift', 1, rarityWeight, 0);
      toys.push({
        ...toy,
        discord_id: user.discord_id,
        source_boss_id: null,
      });
    }

    try {
      await inventoryModel.insertToys(toys);
      seeded++;
    } catch (err) {
      logger.error('Toy seed failed for user', { discordId: user.discord_id, error: err.message });
    }
  }

  logger.info('Starter toy seed complete', { seeded, skipped });
  process.exit(0);
}

seedStarterToys().catch(err => {
  logger.error('Starter toy seed fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});

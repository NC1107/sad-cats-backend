/**
 * One-time script: Give all existing users 5 random starter toys.
 * Idempotent — skips users who already have toys.
 *
 * Run: docker exec sad-cats-api node src/scripts/seed-starter-toys.js
 */

const pool = require('../config/database');
const toyService = require('../services/toy.service');
const inventoryModel = require('../models/inventory.model');

async function seedStarterToys() {
  console.log('Fetching all users from scores table...');
  const { rows: users } = await pool.query('SELECT discord_id FROM scores');
  console.log(`Found ${users.length} users`);

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
      console.error(`Failed for ${user.discord_id}: ${err.message}`);
    }
  }

  console.log(`Done! Seeded: ${seeded}, Skipped (already had toys): ${skipped}`);
  process.exit(0);
}

seedStarterToys().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

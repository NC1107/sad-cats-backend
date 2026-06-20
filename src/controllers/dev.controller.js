const pool = require('../config/database');
const { generateToken } = require('../services/jwt.service');
const cardModel = require('../models/card.model');
const logger = require('../utils/logger');

// Fixed dev identity. The discord_id matches a value you can also list in
// ADMIN_DISCORD_IDS to exercise admin flows locally.
const DEV_USER = {
  userId: 'dev-user',
  discordId: '100000000000000001',
  username: 'DevTester',
  avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
};

// A spread of catalog cards (incl. a couple duplicates) so the roster, party
// (4 slots), and dispatch (up to 4 cats) all have something to work with.
const SEED_CARD_IDS = [
  'shadow',    // common
  'teddy',     // uncommon
  'pixel',     // rare
  'rosebud',   // epic
  'specter',   // legendary
  'isotope',   // mythic
  'patches',   // rare
  'midas',     // legendary
  'shadow',    // duplicate common (test dup leveling / sell guard)
  'rosebud',   // duplicate epic
];

/**
 * POST /api/dev/login   { asMember? }
 * Dev-only: ensure the test user exists (+ seed cards on first call), then mint
 * a real JWT so the SPA can exercise authenticated endpoints without Discord
 * OAuth. Mounted behind a guard that 404s when NODE_ENV === 'production'.
 */
const devLogin = async (req, res, next) => {
  try {
    const asMember = req.body?.asMember !== false; // default true
    const { discordId, username, avatarUrl } = DEV_USER;

    // Upsert the user row (FK target for cards / RPG tables). Don't touch score.
    await pool.query(
      `INSERT INTO scores (discord_id, username, avatar_url, score)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (discord_id)
       DO UPDATE SET username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
      [discordId, username, avatarUrl]
    );

    // Seed cards only if the dev user has none yet.
    const existing = await pool.query('SELECT COUNT(*)::int AS n FROM player_cards WHERE discord_id = $1', [discordId]);
    if ((existing.rows[0]?.n || 0) === 0) {
      for (const cardId of SEED_CARD_IDS) {
        try {
          await cardModel.insertPlayerCard(discordId, cardId, 'dev', false);
        } catch (e) {
          logger.warn('dev seed: skipped a card', { cardId, error: e.message });
        }
      }
      logger.info('dev login: seeded starter cards', { discordId, count: SEED_CARD_IDS.length });
    }

    const token = generateToken({ ...DEV_USER, isMember: asMember });
    res.json({
      success: true,
      token,
      user: { discordId, username, avatarUrl, isMember: asMember },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { devLogin, DEV_USER };

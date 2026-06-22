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

// A separate identity for validating the brand-new-player path: never seeded,
// so it lands on the starter picker with zero cats. Resettable via { reset:true }.
const FRESH_USER = {
  userId: 'dev-fresh',
  discordId: '100000000000000002',
  username: 'FreshCat',
  avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png',
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
    // { fresh:true } → log in as the un-seeded new-player identity (zero cats).
    // { fresh:true, reset:true } → also wipe its RPG state first, for a clean
    // from-scratch playtest. `reset` is ignored for the normal dev user.
    const fresh = req.body?.fresh === true;
    const reset = req.body?.reset === true;
    const identity = fresh ? FRESH_USER : DEV_USER;
    const { discordId, username, avatarUrl } = identity;

    // Upsert the user row (FK target for cards / RPG tables). Don't touch score.
    await pool.query(
      `INSERT INTO scores (discord_id, username, avatar_url, score)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (discord_id)
       DO UPDATE SET username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
      [discordId, username, avatarUrl]
    );

    // Wipe the fresh account's RPG/collection state for a true from-scratch run.
    // Scoped to FRESH_USER only — never the real dev user or anyone else.
    if (fresh && reset && discordId === FRESH_USER.discordId) {
      // player_cat_stats + player_party cascade from player_cards on delete.
      for (const sql of [
        'DELETE FROM player_cards WHERE discord_id = $1',
        'DELETE FROM player_story_progress WHERE discord_id = $1',
        'DELETE FROM player_story_claims WHERE discord_id = $1',
        'DELETE FROM rpg_starter_grants WHERE discord_id = $1',
        'DELETE FROM inventory_toys WHERE discord_id = $1',
      ]) {
        await pool.query(sql, [discordId]).catch(e => logger.warn('dev reset skip', { sql, error: e.message }));
      }
      logger.info('dev login: reset fresh account', { discordId });
    }

    // Seed cards only for the normal dev user, and only if it has none yet. The
    // fresh identity is never seeded — that's the whole point of it.
    if (!fresh) {
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
    }

    const token = generateToken({ ...identity, isMember: asMember });
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

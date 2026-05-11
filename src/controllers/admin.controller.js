const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');
const { ADMIN_IDS } = require('../middleware/admin');
const BossModel = require('../models/boss.model');
const { distributeToys, getDefeatedBossCount } = BossModel;
const { SCORE_CAP } = require('../models/score.model');
const { computeTrustFactor } = require('../services/trust.service');

// Discord snowflake IDs are decimal integers up to ~20 digits. Validating up-front guarantees
// any user-controlled discordId can be safely interpolated into filesystem paths or SQL
// (Sonar S2083 / CWE-22 path traversal — admin endpoints construct backup-file paths that
// would otherwise inherit traversal sequences from the request).
const SNOWFLAKE_RE = /^\d{1,32}$/;
const requireValidDiscordId = (req, res) => {
  const id = req.params?.discordId;
  if (!id || !SNOWFLAKE_RE.test(id)) {
    res.status(400).json({ success: false, error: 'Invalid discordId — expected a numeric Discord snowflake' });
    return null;
  }
  return id;
};

// Audit-logging helper. The admin JWT shape historically varied — some flows use
// `req.user.data.discordId`, others use `req.user.sub`. Centralizing the fallback
// here means a future JWT-shape refactor only has to touch one place. See issue
// #20 for the larger plan to normalize `req.user` at the middleware boundary.
const getActorId = (req) => req.user?.data?.discordId || req.user?.sub || null;

/**
 * Check if current user is admin (lightweight endpoint for frontend)
 */
const checkAdmin = (req, res) => {
  res.json({ success: true, isAdmin: ADMIN_IDS.includes(getActorId(req)) });
};

/**
 * Get system overview stats
 */
const getStats = async (req, res, next) => {
  try {
    const [users, boss, redis_info] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as total_users,
          COUNT(*) FILTER (WHERE score > 0) as active_users,
          SUM(score) as total_score,
          MAX(score) as top_score
        FROM scores
      `),
      pool.query('SELECT * FROM cat_bosses ORDER BY id DESC LIMIT 1'),
      redisClient.info ? redisClient.info() : Promise.resolve(null)
    ]);

    const userStats = users.rows[0];
    const currentBoss = boss.rows[0] || null;

    res.json({
      success: true,
      stats: {
        totalUsers: parseInt(userStats.total_users),
        activeUsers: parseInt(userStats.active_users),
        totalScore: userStats.total_score,
        topScore: userStats.top_score,
        boss: currentBoss
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List all users with scores + basic game state info
 */
const listUsers = async (req, res, next) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    let query, values;

    if (search) {
      query = `
        SELECT discord_id, username, avatar_url, score, updated_at,
               (game_state->>'prestigeLevel')::int as prestige_level,
               (game_state->>'lifetimeEarnings') as lifetime_earnings
        FROM scores
        WHERE username ILIKE $1 OR discord_id = $2
        ORDER BY score DESC
        LIMIT $3 OFFSET $4
      `;
      values = [`%${search}%`, search, limit, offset];
    } else {
      query = `
        SELECT discord_id, username, avatar_url, score, updated_at,
               (game_state->>'prestigeLevel')::int as prestige_level,
               (game_state->>'lifetimeEarnings') as lifetime_earnings
        FROM scores
        ORDER BY score DESC
        LIMIT $1 OFFSET $2
      `;
      values = [limit, offset];
    }

    const result = await pool.query(query, values);
    res.json({ success: true, users: result.rows });
  } catch (error) {
    next(error);
  }
};

/**
 * Get full user details including game state
 */
const getUser = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const result = await pool.query(
      'SELECT discord_id, username, avatar_url, score, game_state, updated_at FROM scores WHERE discord_id = $1',
      [discordId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

/**
 * Set a user's score to an exact value
 */
const setUserScore = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const { score } = req.body;
    if (score === undefined || score < 0) {
      return res.status(400).json({ success: false, error: 'Invalid score' });
    }

    // Cast NUMERIC (not BIGINT — column was migrated in 021) and clamp into the
    // [0, SCORE_CAP] range so an admin can't poke a value through the same invariant
    // the regular addToScore enforces. Score arrives as Number (capped at 1e308 client-side)
    // — we let pg accept it as text and cast it ourselves so values past 2^63 don't throw.
    const result = await pool.query(
      `UPDATE scores
         SET score = LEAST(${SCORE_CAP}::NUMERIC, GREATEST(0, $1::NUMERIC)),
             updated_at = NOW()
       WHERE discord_id = $2
       RETURNING discord_id, username, score`,
      [String(score), discordId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const adminId = getActorId(req);
    logger.info('Admin set user score', { adminId, targetId: discordId, newScore: score });

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

/**
 * Reset a user's game state AND score. Creates a backup file first.
 */
const resetUserGameState = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;

    // Fetch current state before wiping
    const current = await pool.query(
      'SELECT discord_id, username, score, game_state FROM scores WHERE discord_id = $1',
      [discordId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Write backup file
    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${discordId}_${timestamp}.json`;
    fs.writeFileSync(
      path.join(backupDir, filename),
      JSON.stringify(current.rows[0], null, 2)
    );

    // Wipe game_state AND score (bump _adminVersion to invalidate stale client saves)
    const currentVersion = current.rows[0]?.game_state?._adminVersion || 0;
    const newVersion = Math.max(currentVersion + 1, 99999);
    const result = await pool.query(
      `UPDATE scores SET game_state = jsonb_build_object('_adminVersion', $2::int), score = 0, updated_at = NOW() WHERE discord_id = $1 RETURNING discord_id, username`,
      [discordId, newVersion]
    );

    const adminId = getActorId(req);
    logger.info('Admin reset user game state', { adminId, targetId: discordId, backupFile: filename });

    res.json({ success: true, user: result.rows[0], backupFile: filename });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a named snapshot of a user's current save (without wiping)
 */
const createSnapshot = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const { label } = req.body || {};

    const current = await pool.query(
      'SELECT discord_id, username, score, game_state FROM scores WHERE discord_id = $1',
      [discordId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = (label || 'snap').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
    const filename = `${discordId}_${safeName}_${timestamp}.json`;
    fs.writeFileSync(path.join(backupDir, filename), JSON.stringify(current.rows[0], null, 2));

    const adminId = getActorId(req);
    logger.info('Admin created snapshot', { adminId, targetId: discordId, filename });

    res.json({ success: true, filename });
  } catch (error) {
    next(error);
  }
};

/**
 * List all snapshots for a user
 */
const listSnapshots = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;

    const backupDir = path.join(__dirname, '../../backups');
    const snapshots = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir)
          .filter(f => f.startsWith(discordId) && f.endsWith('.json'))
          .map(f => ({ filename: f, created: fs.statSync(path.join(backupDir, f)).mtime }))
          .sort((a, b) => b.created - a.created)
      : [];

    res.json({ success: true, snapshots });
  } catch (error) {
    next(error);
  }
};

/**
 * Restore a user's save from a named snapshot
 */
const restoreSnapshot = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const { filename } = req.body || {};

    if (!filename || !filename.startsWith(discordId) || filename.includes('/') || filename.includes('..')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }

    const filePath = path.join(__dirname, '../../backups', filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Snapshot not found' });
    }

    const snap = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const newVersion = Math.max((snap.game_state?._adminVersion || 0) + 1, 99999);
    snap.game_state._adminVersion = newVersion;

    await pool.query(
      'UPDATE scores SET score = $1::BIGINT, game_state = $2::jsonb, updated_at = NOW() WHERE discord_id = $3',
      [snap.score, JSON.stringify(snap.game_state), discordId]
    );

    const adminId = getActorId(req);
    logger.info('Admin restored snapshot', { adminId, targetId: discordId, filename });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a user's game state (and optionally score)
 */
const updateUserGameState = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const { gameState, score } = req.body;
    if (!gameState || typeof gameState !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid gameState — must be a JSON object' });
    }

    // Bump _adminVersion so auto-save from stale clients gets rejected
    const existing = await pool.query('SELECT game_state FROM scores WHERE discord_id = $1', [discordId]);
    const currentVersion = existing.rows[0]?.game_state?._adminVersion || 0;
    gameState._adminVersion = currentVersion + 1;

    let result;
    if (score !== undefined) {
      result = await pool.query(
        'UPDATE scores SET game_state = $1::jsonb, score = $2::BIGINT, updated_at = NOW() WHERE discord_id = $3 RETURNING discord_id, username, score, game_state',
        [JSON.stringify(gameState), score, discordId]
      );
    } else {
      result = await pool.query(
        'UPDATE scores SET game_state = $1::jsonb, updated_at = NOW() WHERE discord_id = $2 RETURNING discord_id, username, score, game_state',
        [JSON.stringify(gameState), discordId]
      );
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const adminId = getActorId(req);
    logger.info('Admin updated user game state', { adminId, targetId: discordId, scoreSet: score !== undefined, adminVersion: gameState._adminVersion });

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

/**
 * Reset all bosses (delete all bosses + contributions)
 */
const resetBoss = async (req, res, next) => {
  try {
    const { bossId } = req.body || {};
    if (bossId) {
      // Nullify FK refs, then delete boss + contributions
      await pool.query('UPDATE inventory_toys SET source_boss_id = NULL WHERE source_boss_id = $1', [bossId]);
      await pool.query('DELETE FROM boss_toy_distributions WHERE boss_id = $1', [bossId]);
      await pool.query('DELETE FROM boss_contributions WHERE boss_id = $1', [bossId]);
      await pool.query('DELETE FROM cat_bosses WHERE id = $1', [bossId]);
    } else {
      // Nullify all FK refs, then delete all
      await pool.query('UPDATE inventory_toys SET source_boss_id = NULL WHERE source_boss_id IS NOT NULL');
      await pool.query('DELETE FROM boss_toy_distributions');
      await pool.query('DELETE FROM boss_contributions');
      await pool.query('DELETE FROM cat_bosses');
    }

    const adminId = getActorId(req);
    logger.info('Admin reset boss', { adminId, bossId: bossId || 'all' });

    res.json({ success: true, message: bossId ? 'Boss deleted.' : 'All bosses reset.' });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all daily bosses with contributor counts
 */
const getBossDetails = async (req, res, next) => {
  try {
    const dateKey = BossModel.getTodayKey();
    const allBosses = await pool.query(
      'SELECT * FROM cat_bosses WHERE spawn_date = $1 ORDER BY id ASC',
      [dateKey]
    );
    // Fetch contributor counts per boss
    const bossesWithContribs = await Promise.all(allBosses.rows.map(async (boss) => {
      const contribs = await pool.query(
        `SELECT discord_id, username, damage_dealt, reward_claimed, buff_expires_at
         FROM boss_contributions WHERE boss_id = $1
         ORDER BY damage_dealt DESC LIMIT 50`,
        [boss.id]
      );
      return { ...boss, contributors: contribs.rows };
    }));

    res.json({ success: true, bosses: bossesWithContribs });
  } catch (error) {
    next(error);
  }
};

/**
 * Set a specific boss's HP
 */
const setBossHP = async (req, res, next) => {
  try {
    const { hp, bossId } = req.body;
    if (!hp || isNaN(Number(hp))) {
      return res.status(400).json({ success: false, error: 'Invalid HP value' });
    }
    if (!bossId) {
      return res.status(400).json({ success: false, error: 'bossId required' });
    }

    const result = await pool.query(
      'UPDATE cat_bosses SET current_hp = $1::BIGINT WHERE id = $2 RETURNING *',
      [hp, bossId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No boss found' });
    }

    const adminId = getActorId(req);
    logger.info('Admin set boss HP', { adminId, hp, bossId });

    res.json({ success: true, boss: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

/**
 * Instantly defeat a specific boss
 */
const defeatBoss = async (req, res, next) => {
  try {
    const { bossId } = req.body || {};
    if (!bossId) {
      return res.status(400).json({ success: false, error: 'bossId required' });
    }

    const result = await pool.query(
      `UPDATE cat_bosses SET current_hp = 0, defeated = TRUE, defeated_at = NOW()
       WHERE id = $1 AND NOT defeated
       RETURNING *`,
      [bossId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No active boss found' });
    }

    const boss = result.rows[0];
    const adminId = getActorId(req);
    logger.info('Admin defeated boss', { adminId, bossId: boss.id });

    // Distribute toys to contributors (fire-and-forget)
    distributeToys(bossId, boss).catch(err =>
      logger.error('Toy distribution failed after admin defeat', { error: err.message, bossId })
    );

    res.json({ success: true, boss });
  } catch (error) {
    next(error);
  }
};

/**
 * Spawn a new boss for today.
 * Accepts body: { bossIndex: number, level: number }
 */
const spawnBoss = async (req, res, next) => {
  try {
    const { bossIndex, level } = req.body || {};
    const dateKey = BossModel.getTodayKey();
    const parsedBossIndex = Number.isInteger(bossIndex) ? bossIndex : parseInt(bossIndex, 10);

    let chosen;
    if (Number.isInteger(parsedBossIndex) && parsedBossIndex >= 0 && parsedBossIndex < BossModel.BOSS_NAMES.length) {
      chosen = BossModel.BOSS_NAMES[parsedBossIndex];
    } else {
      // Pick weighted-random boss not already spawned today
      const existing = await pool.query('SELECT boss_name FROM cat_bosses WHERE spawn_date = $1', [dateKey]);
      const usedNames = new Set(existing.rows.map(r => r.boss_name));
      const available = BossModel.BOSS_NAMES.filter(b => !usedNames.has(b.name));

      if (available.length === 0) {
        return res.status(409).json({ success: false, error: 'All bosses have already been spawned for today' });
      } else {
        const totalWeight = available.reduce((sum, b) => sum + (Number(b.rarityWeight) || 1), 0);
        let roll = Math.random() * totalWeight;
        chosen = available[available.length - 1];

        for (const boss of available) {
          roll -= (Number(boss.rarityWeight) || 1);
          if (roll <= 0) {
            chosen = boss;
            break;
          }
        }
      }
    }

    const parsedLevel = parseInt(level, 10);
    let selectedLevel;
    if (Number.isInteger(parsedLevel) && parsedLevel >= 1 && parsedLevel <= 5) {
      selectedLevel = parsedLevel;
    } else {
      // Weighted random level to match schedule behavior
      const r = Math.random();
      selectedLevel = r < 0.60 ? 1 : r < 0.83 ? 2 : r < 0.93 ? 3 : r < 0.98 ? 4 : 5;
    }

    const lvl = BossModel.BOSS_LEVELS[selectedLevel - 1] || BossModel.BOSS_LEVELS[0];
    const hpRange = BossModel.getScaledHpRange(selectedLevel, chosen.name);

    const hp = String(Math.floor(Math.random() * (hpRange.maxHP - hpRange.minHP + 1)) + hpRange.minHP);

    const existsResult = await pool.query(
      'SELECT id FROM cat_bosses WHERE spawn_date = $1 AND boss_name = $2 LIMIT 1',
      [dateKey, chosen.name]
    );
    if (existsResult.rows.length > 0) {
      return res.status(409).json({ success: false, error: `${chosen.name} is already spawned today` });
    }

    const result = await pool.query(
      `INSERT INTO cat_bosses (week_key, boss_name, boss_emoji, max_hp, current_hp, reward_pool, boss_level, buff_duration_minutes, spawn_date)
       VALUES ($1, $2, $3, $4::BIGINT, $4::BIGINT, 0, $5, $6, $7)
       ON CONFLICT (spawn_date, boss_name) DO NOTHING
       RETURNING *`,
      [null, chosen.name, chosen.emoji, hp, selectedLevel, lvl.buffMinutes, dateKey]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, error: `${chosen.name} is already spawned today` });
    }

    const adminId = getActorId(req);
    logger.info('Admin spawned new boss', {
      adminId,
      bossId: result.rows[0].id,
      name: chosen.name,
      level: selectedLevel,
      hp,
      hpRange
    });

    res.json({ success: true, boss: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

/**
 * Get feature flags
 */
const getFlags = async (req, res, next) => {
  try {
    const [adReroll, bossSpawning, robCmd, giveCmd, duelCmd, lotteryCmd] = await Promise.all([
      redisClient.get('config:adRerollEnabled'),
      redisClient.get('config:bossSpawningEnabled'),
      redisClient.get('config:robCommandEnabled'),
      redisClient.get('config:giveCommandEnabled'),
      redisClient.get('config:duelCommandEnabled'),
      redisClient.get('config:lotteryCommandEnabled')
    ]);
    res.json({
      success: true, flags: {
        adRerollEnabled: adReroll === 'true',
        bossSpawningEnabled: bossSpawning !== 'false',  // default true
        robCommandEnabled: robCmd !== 'false',           // default true
        giveCommandEnabled: giveCmd !== 'false',         // default true
        duelCommandEnabled: duelCmd !== 'false',         // default true
        lotteryCommandEnabled: lotteryCmd !== 'false'    // default true
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Toggle a feature flag
 */
const setFlag = async (req, res, next) => {
  try {
    const { flag } = req.params;
    const { enabled } = req.body;
    const allowedFlags = ['adRerollEnabled', 'bossSpawningEnabled', 'robCommandEnabled', 'giveCommandEnabled', 'duelCommandEnabled', 'lotteryCommandEnabled'];
    if (!allowedFlags.includes(flag)) {
      return res.status(400).json({ success: false, error: 'Unknown flag' });
    }
    await redisClient.set(`config:${flag}`, String(!!enabled));
    const adminId = getActorId(req);
    logger.info('Admin toggled flag', { adminId, flag, enabled: !!enabled });
    res.json({ success: true, flag, enabled: !!enabled });
  } catch (error) {
    next(error);
  }
};

/**
 * Get enhanced admin stats: economy overview, suspicious players, recent activity
 */
const getEnhancedStats = async (req, res, next) => {
  try {
    const [overview, topPlayers, recentActive, economy, negativeBalances] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as total_users,
          COUNT(*) FILTER (WHERE score > 0) as active_users,
          COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '24 hours') as active_24h,
          COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days') as active_7d,
          SUM(score) as total_score,
          MAX(score) as top_score,
          AVG(score) FILTER (WHERE score > 0) as avg_score,
          SUM(gambling_net) as total_gambling_net,
          COUNT(*) FILTER (WHERE gambling_net < 0) as gambling_losers,
          COUNT(*) FILTER (WHERE gambling_net > 0) as gambling_winners
        FROM scores
      `),
      // Top 10 players for quick reference
      pool.query(`
        SELECT discord_id, username, avatar_url, score, gambling_net,
               game_state, created_at
        FROM scores ORDER BY score DESC LIMIT 10
      `),
      // Recently active players (last 24h)
      pool.query(`
        SELECT discord_id, username, avatar_url, score, gambling_net,
               game_state, updated_at
        FROM scores
        WHERE updated_at > NOW() - INTERVAL '24 hours'
        ORDER BY updated_at DESC LIMIT 20
      `),
      // Economy: all positive scores for dynamic histogram
      pool.query(`
        SELECT score FROM scores WHERE score > 0 ORDER BY score ASC
      `),
      // Players in debt
      pool.query(`
        SELECT discord_id, username, score
        FROM scores WHERE score < 0
        ORDER BY score ASC LIMIT 10
      `)
    ]);

    // Compute trust for top players to find suspicious ones
    const suspiciousPlayers = [];
    for (const player of topPlayers.rows) {
      let bossesDefeated = 0;
      try { bossesDefeated = await getDefeatedBossCount(player.discord_id); } catch {}
      const trust = computeTrustFactor(player.game_state, player.created_at, bossesDefeated);
      if (trust.score < 80) {
        suspiciousPlayers.push({
          discord_id: player.discord_id,
          username: player.username,
          avatar_url: player.avatar_url,
          score: player.score,
          trustScore: trust.score,
          trustTier: trust.tier,
          penalties: trust.penalties
        });
      }
    }

    // Also check all players with very low trust
    const allSuspicious = await pool.query(`
      SELECT discord_id, username, avatar_url, score, game_state, created_at
      FROM scores WHERE score > 100000
      ORDER BY score DESC LIMIT 100
    `);

    for (const player of allSuspicious.rows) {
      if (suspiciousPlayers.some(s => s.discord_id === player.discord_id)) continue;
      let bossesDefeated = 0;
      try { bossesDefeated = await getDefeatedBossCount(player.discord_id); } catch {}
      const trust = computeTrustFactor(player.game_state, player.created_at, bossesDefeated);
      if (trust.score < 60) {
        suspiciousPlayers.push({
          discord_id: player.discord_id,
          username: player.username,
          avatar_url: player.avatar_url,
          score: player.score,
          trustScore: trust.score,
          trustTier: trust.tier,
          penalties: trust.penalties
        });
      }
    }

    suspiciousPlayers.sort((a, b) => a.trustScore - b.trustScore);

    // Enrich recent active with quick stats
    const recentPlayers = recentActive.rows.map(p => ({
      discord_id: p.discord_id,
      username: p.username,
      avatar_url: p.avatar_url,
      score: p.score,
      gambling_net: p.gambling_net,
      prestigeLevel: p.game_state?.prestigeLevel || 0,
      ascensionLevel: p.game_state?.ascensionLevel || 0,
      updated_at: p.updated_at
    }));

    // Build prestige-aligned histogram from positive scores
    // Prestige threshold = 100000 * 10^level → P0=100K, P1=1M, ... P15=10Sx
    const inDebtCount = await pool.query('SELECT COUNT(*) as count FROM scores WHERE score < 0');
    const positiveScores = economy.rows.map(r => Number(r.score));
    const buckets = [];
    if (positiveScores.length > 0) {
      // Pre-prestige bin
      buckets.push({ label: '<P0', count: positiveScores.filter(s => s < 100000).length });
      // P0 through P15
      for (let p = 0; p <= 15; p++) {
        const lo = 100000 * Math.pow(10, p);
        const hi = 100000 * Math.pow(10, p + 1);
        const count = positiveScores.filter(s => s >= lo && s < hi).length;
        if (count > 0 || p < 3) buckets.push({ label: `P${p}`, count });
      }
      // P16+
      const p16count = positiveScores.filter(s => s >= 100000 * Math.pow(10, 16)).length;
      if (p16count > 0) buckets.push({ label: 'P16+', count: p16count });
    }

    res.json({
      success: true,
      overview: overview.rows[0],
      economy: { buckets, inDebt: Number(inDebtCount.rows[0].count) },
      topPlayers: topPlayers.rows.map(p => ({
        discord_id: p.discord_id,
        username: p.username,
        avatar_url: p.avatar_url,
        score: p.score,
        gambling_net: p.gambling_net,
        prestigeLevel: p.game_state?.prestigeLevel || 0,
        ascensionLevel: p.game_state?.ascensionLevel || 0,
      })),
      suspiciousPlayers,
      recentPlayers,
      negativeBalances: negativeBalances.rows
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Save/load dev presets for testing different game stages
 */
const DEV_PRESETS = {
  early: {
    label: 'Early Game',
    score: 5000,
    gameState: {
      balance: 5000,
      clickPower: 1,
      clickMultiplier: 1,
      catsPerSecond: 0,
      cpsMultiplier: 1,
      autoClicksPerSecond: 0,
      upgrades: { clickPower: 2, catnipBoost: 1, laserPointer: 0, catNap: 0, meowMixer: 0, felineFrenzy: 0, purringMotor: 0, catCafe: 0, kittyKingdom: 0 },
      prestigeLevel: 0,
      prestigeMultiplier: 1,
      ascensionLevel: 0,
      ascensionMultiplier: 1,
      lifetimeEarnings: 5000,
      unlockedAchievements: ['babySteps', 'kitten'],
      starShards: 0,
      skillTree: {},
      cycleEarnings: 5000,
      cosmicPrestigeBonus: 0,
      totalClicks: 500,
      totalClickTime: 300,
      totalMicroQuestsCompleted: 0,
    }
  },
  mid: {
    label: 'Mid Game',
    score: 50000000,
    gameState: {
      balance: 50000000,
      clickPower: 50,
      clickMultiplier: 3,
      catsPerSecond: 200,
      cpsMultiplier: 2,
      autoClicksPerSecond: 5,
      upgrades: { clickPower: 15, catnipBoost: 10, laserPointer: 8, catNap: 6, meowMixer: 5, felineFrenzy: 3, purringMotor: 2, catCafe: 1, kittyKingdom: 0 },
      prestigeLevel: 5,
      prestigeMultiplier: 4.625,
      ascensionLevel: 0,
      ascensionMultiplier: 1,
      lifetimeEarnings: 500000000,
      unlockedAchievements: ['babySteps', 'kitten', 'cat', 'fatCat', 'catLord', 'catEmperor', 'investor', 'collector', 'shopaholic', 'reborn', 'transcended', 'veteran', 'lazyCat', 'automation', 'millionaire'],
      starShards: 12,
      skillTree: {},
      cycleEarnings: 50000000,
      cosmicPrestigeBonus: 0.3,
      totalClicks: 50000,
      totalClickTime: 36000,
      totalMicroQuestsCompleted: 15,
    }
  },
  late: {
    label: 'Late Game',
    score: 9007199254740000,
    gameState: {
      balance: 9007199254740000,
      clickPower: 5000,
      clickMultiplier: 20,
      catsPerSecond: 50000,
      cpsMultiplier: 15,
      autoClicksPerSecond: 20,
      upgrades: { clickPower: 50, catnipBoost: 40, laserPointer: 35, catNap: 30, meowMixer: 25, felineFrenzy: 20, purringMotor: 15, catCafe: 10, kittyKingdom: 5 },
      prestigeLevel: 15,
      prestigeMultiplier: 21.125,
      ascensionLevel: 5,
      ascensionMultiplier: 10,
      lifetimeEarnings: 99999999999999,
      unlockedAchievements: ['babySteps', 'kitten', 'cat', 'fatCat', 'catLord', 'catEmperor', 'catGod', 'investor', 'collector', 'shopaholic', 'maxedOut', 'mogul', 'reborn', 'transcended', 'veteran', 'eternal', 'lazyCat', 'automation', 'catFactory', 'catEmpire', 'millionaire', 'ascended', 'celestial', 'questNovice', 'questMaster'],
      starShards: 80,
      skillTree: {},
      cycleEarnings: 9007199254740000,
      cosmicPrestigeBonus: 2.0,
      totalClicks: 500000,
      totalClickTime: 360000,
      totalMicroQuestsCompleted: 60,
    }
  }
};

const loadDevPreset = async (req, res, next) => {
  try {
    const { preset } = req.params;
    const { discordId } = req.body;
    if (!DEV_PRESETS[preset]) {
      return res.status(400).json({ success: false, error: `Unknown preset: ${preset}` });
    }
    if (!discordId) {
      return res.status(400).json({ success: false, error: 'discordId required' });
    }

    const p = DEV_PRESETS[preset];
    const adminId = getActorId(req);

    // Bump _adminVersion to invalidate stale client saves
    const existing = await pool.query('SELECT game_state FROM scores WHERE discord_id = $1', [discordId]);
    const currentVersion = existing.rows[0]?.game_state?._adminVersion || 0;
    const newState = { ...p.gameState, _adminVersion: currentVersion + 1 };

    await pool.query(
      `UPDATE scores SET score = $1::BIGINT, game_state = $2, updated_at = NOW() WHERE discord_id = $3`,
      [p.score, JSON.stringify(newState), discordId]
    );

    logger.info('Admin loaded dev preset', { adminId, discordId, preset });
    res.json({ success: true, preset, label: p.label });
  } catch (error) {
    next(error);
  }
};

const getDevPresets = (req, res) => {
  const presets = Object.entries(DEV_PRESETS).map(([key, p]) => ({
    key,
    label: p.label,
    score: p.score,
    prestigeLevel: p.gameState.prestigeLevel,
    ascensionLevel: p.gameState.ascensionLevel,
  }));
  res.json({ success: true, presets });
};

/**
 * Get CPS history for a user from Redis
 */
const getCpsHistory = async (req, res) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const key = `cps:${discordId}`;
    const raw = await redisClient.zRange(key, 0, -1, { REV: false });

    const samples = raw.map(entry => {
      const parts = entry.split(':');
      const cps = parseFloat(parts[parts.length - 1]) || 0;
      const timestamp = parseInt(parts[0]) || 0;
      return { timestamp, cps };
    }).filter(s => s.timestamp > 0);

    res.json({ success: true, samples, count: samples.length });
  } catch (error) {
    logger.error('Error fetching CPS history', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to fetch CPS history' });
  }
};

/**
 * Reset ALL players (scores + game state) with a full backup first
 */
const resetAllPlayers = async (req, res, next) => {
  try {

    // Fetch all player data for backup
    const allUsers = await pool.query(
      'SELECT discord_id, username, score, game_state, updated_at FROM scores'
    );

    if (allUsers.rows.length === 0) {
      return res.json({ success: true, usersReset: 0, message: 'No players to reset' });
    }

    // Write backup file
    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `bulk_reset_${timestamp}.json`;
    fs.writeFileSync(
      path.join(backupDir, filename),
      JSON.stringify({ resetAt: new Date().toISOString(), playerCount: allUsers.rows.length, players: allUsers.rows }, null, 2)
    );

    // Reset all players
    await pool.query(`UPDATE scores SET game_state = '{"_adminVersion": 9999}'::jsonb, score = 0, updated_at = NOW()`);

    const adminId = getActorId(req);
    logger.info('Admin reset ALL players', { adminId, usersReset: allUsers.rows.length, backupFile: filename });

    res.json({ success: true, usersReset: allUsers.rows.length, backupFile: filename });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/reset-infinity-leaderboard
 * Reset all speedrun/infinity tracking data
 */
const resetInfinityLeaderboard = async (req, res, next) => {
  try {
    const { confirm } = req.body;
    if (!confirm) {
      return res.status(400).json({ error: 'Must send { confirm: true }' });
    }

    const result = await pool.query(`
      UPDATE scores
      SET best_speedrun_seconds = NULL,
          infinity_reached_at = NULL,
          speedrun_run_start = NULL
      WHERE best_speedrun_seconds IS NOT NULL
         OR infinity_reached_at IS NOT NULL
         OR speedrun_run_start IS NOT NULL
    `);

    const adminId = getActorId(req);
    logger.info('Admin reset infinity leaderboard', { adminId, rowsAffected: result.rowCount });

    res.json({ success: true, rowsReset: result.rowCount });
  } catch (error) {
    next(error);
  }
};

// ---------- Inventory Management ----------

const inventoryModel = require('../models/inventory.model');
const cardModel = require('../models/card.model');
const toyService = require('../services/toy.service');

const getUserInventory = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const [toys, toyCounts, cards, catnip, cases] = await Promise.all([
      inventoryModel.getToys(discordId, { limit: 500 }),
      inventoryModel.getToyCounts(discordId),
      cardModel.getPlayerCards(discordId),
      cardModel.getCatnip(discordId),
      cardModel.getPlayerCases ? cardModel.getPlayerCases(discordId) : Promise.resolve([]),
    ]);
    res.json({ success: true, toys, toyCounts, cards, catnip, cases });
  } catch (error) { next(error); }
};

const adminGiveToys = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const { toyType, quantity = 1 } = req.body;
    if (!toyType || quantity < 1 || quantity > 50) {
      return res.status(400).json({ success: false, error: 'Invalid toyType or quantity (1-50)' });
    }
    const toys = [];
    for (let i = 0; i < quantity; i++) {
      const tier = toyService.TOY_TIERS.find(t => t.type === toyType);
      if (!tier) return res.status(400).json({ success: false, error: 'Unknown toy type' });
      const toy = toyService.generateToy('Admin Gift', 1, tier.minWeight, 0);
      toys.push({ ...toy, discord_id: discordId, source_boss_id: null });
    }
    await inventoryModel.insertToys(toys);
    logger.info('Admin gave toys', { discordId, toyType, quantity, adminId: req.user?.data?.discordId });
    res.json({ success: true, count: toys.length });
  } catch (error) { next(error); }
};

const adminGiveCard = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const { cardId } = req.body;
    if (!cardId) return res.status(400).json({ success: false, error: 'cardId required' });
    await cardModel.insertPlayerCard(discordId, cardId);
    logger.info('Admin gave card', { discordId, cardId, adminId: req.user?.data?.discordId });
    res.json({ success: true });
  } catch (error) { next(error); }
};

const adminGiveCatnip = async (req, res, next) => {
  try {
    const discordId = requireValidDiscordId(req, res);
    if (discordId === null) return;
    const { amount } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ success: false, error: 'amount required (>0)' });
    await cardModel.addCatnip(discordId, amount);
    logger.info('Admin gave catnip', { discordId, amount, adminId: req.user?.data?.discordId });
    res.json({ success: true });
  } catch (error) { next(error); }
};

const adminRemoveToy = async (req, res, next) => {
  try {
    const { discordId, toyId } = req.params;
    await pool.query('DELETE FROM inventory_toys WHERE id = $1 AND discord_id = $2', [toyId, discordId]);
    logger.info('Admin removed toy', { discordId, toyId, adminId: req.user?.data?.discordId });
    res.json({ success: true });
  } catch (error) { next(error); }
};

const adminRemoveCard = async (req, res, next) => {
  try {
    const { discordId, cardId } = req.params;
    await pool.query('DELETE FROM player_cards WHERE id = $1 AND discord_id = $2', [cardId, discordId]);
    logger.info('Admin removed card', { discordId, cardId, adminId: req.user?.data?.discordId });
    res.json({ success: true });
  } catch (error) { next(error); }
};

/**
 * Get full card catalog for admin dropdown
 */
const getCardCatalog = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, cat_name, rarity, buff_type, buff_value FROM cat_cards ORDER BY rarity, cat_name'
    );
    res.json({ success: true, cards: result.rows });
  } catch (error) {
    next(error);
  }
};

module.exports = {
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
};

const {
  addToScore: addToScoreModel,
  getTopScoresByPeriod,
  getScoreByDiscordId,
  getUserRank,
  getTotalScoresCount,
  getGameState: getGameStateModel,
  saveGameState: saveGameStateModel,
  getSpeedrunLeaderboard: getSpeedrunLeaderboardModel,
  getAscensionLeaderboard: getAscensionLeaderboardModel,
  getGamblingLeaderboard: getGamblingLeaderboardModel
} = require('../models/score.model');
const pool = require('../config/database');
const { applyDamage: applyBossDamage, applyDamageToCurrentBoss, getDefeatedBossCount } = require('../models/boss.model');
const { getIO, pushActivity } = require('../socket');
const { invalidate } = require('../services/cache.service');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');
const { computeTrustFactor } = require('../services/trust.service');

/**
 * Atomically add to (or subtract from) a user's score
 * Supports both authenticated (web) and unauthenticated (Discord bot) requests
 */
const addToScore = async (req, res, next) => {
  try {
    const { delta, discordId, username, avatarUrl, cps, clickDamage, bossId, allowNegative, source } = req.body;

    // Anti-cheat: reject if CPS exceeds threshold
    if (cps && cps > 17) {
      logger.warn('CPS threshold exceeded', { discordId: discordId || req.user?.data?.discordId, cps });
      return res.status(400).json({
        success: false,
        error: 'Click rate too high'
      });
    }

    // Track CPS history in Redis for trust analysis
    const cpsDiscordId = discordId || req.user?.data?.discordId;
    if (cps && cps > 0 && cpsDiscordId) {
      try {
        const key = `cps:${cpsDiscordId}`;
        const now = Date.now();
        await redisClient.zAdd(key, { score: now, value: `${now}:${cps}` });
        await redisClient.zRemRangeByRank(key, 0, -1001); // Keep last 1000 samples
        await redisClient.expire(key, 7 * 24 * 3600);    // 7 day TTL
      } catch (e) {
        // Non-blocking — don't fail score update for CPS tracking
        logger.warn('CPS Redis tracking failed', { error: e.message });
      }
    }

    let scoreData;
    if (req.user && req.user.data) {
      // Authenticated request from web app — identity from JWT
      const user = req.user.data;

      // Per-user sync lock: prevent overlapping sync requests from inflating scores.
      // Contention returns 429 (not 200) so the client doesn't read score:0 as
      // authoritative and overwrite its local balance. The frontend's syncBackoff
      // already handles "Too many requests" via a 60s backoff (useScoreSync).
      const lockKey = `sync_lock:${user.discordId}`;
      try {
        const locked = await redisClient.set(lockKey, '1', { NX: true, EX: 2 });
        if (!locked) {
          return res.status(429).json({ success: false, skipped: true, error: 'Sync in progress' });
        }
      } catch (e) {
        // Fail closed if Redis is down — prevents score inflation
        logger.error('Redis sync lock unavailable, rejecting request', { error: e.message });
        return res.status(503).json({ error: 'Service temporarily unavailable' });
      }

      // Server-side offline earnings validation (soft cap)
      let validatedDelta = delta;
      if (delta > 0) {
        try {
          const existing = await pool.query('SELECT game_state FROM scores WHERE discord_id = $1', [user.discordId]);
          const gs = existing.rows[0]?.game_state || {};
          const lastCalc = gs.lastCalculated || Date.now();
          const elapsedSec = Math.min((Date.now() - lastCalc) / 1000, 86400 * 3); // max 3 days
          const maxCps = (gs.catsPerSecond || 0) * (gs.cpsMultiplier || 1) * (gs.prestigeMultiplier || 1) * (gs.ascensionMultiplier || 1);
          const maxAutoClick = (gs.autoClicksPerSecond || 0) * (gs.clickPower || 1) * (gs.clickMultiplier || 1) * (gs.prestigeMultiplier || 1) * (gs.ascensionMultiplier || 1);
          const maxDelta = (maxCps + maxAutoClick) * elapsedSec * 10; // 10x grace for skills/buffs
          if (maxDelta > 0 && delta > maxDelta) {
            logger.warn('Suspicious delta', { discordId: user.discordId, delta, maxDelta, elapsedSec });
            validatedDelta = Math.min(delta, maxDelta);
          }
        } catch (e) {
          // Non-blocking — don't fail score update for validation
          logger.warn('Offline earnings validation failed', { error: e.message });
        }
      }

      scoreData = {
        userId: user.userId,
        discordId: user.discordId,
        username: user.username,
        avatarUrl: user.avatarUrl,
        delta: validatedDelta
      };
    } else if (req.botAuthenticated) {
      // Bot request — identity from body, authenticated via x-bot-secret
      if (!discordId || !username) {
        return res.status(400).json({
          success: false,
          error: 'discordId and username are required for bot requests'
        });
      }
      scoreData = {
        userId: null,
        discordId,
        username,
        avatarUrl: avatarUrl || null,
        delta,
        allowNegative: !!allowNegative, // Only bot requests can push negative
        source: source || null
      };
    } else {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const updatedScore = await addToScoreModel(scoreData);

    // Invalidate daily leaderboard cache (most volatile period)
    await invalidate('scores:leaderboard:daily');

    logger.info('Score updated', { discordId: scoreData.discordId, delta, source: req.user ? 'web' : 'bot' });

    // Non-blocking boss damage: only active clicks deal damage
    const bossDmg = clickDamage && clickDamage > 0 ? clickDamage : 0;
    if (bossDmg > 0 && scoreData.discordId) {
      const dmgPromise = bossId
        ? applyBossDamage(bossId, scoreData.discordId, scoreData.username, bossDmg)
        : applyDamageToCurrentBoss(scoreData.discordId, scoreData.username, bossDmg);
      dmgPromise
        .then(boss => {
          if (boss) {
            const io = getIO();
            if (io) {
              io.to('leaderboard').emit('boss:hp_update', { boss });
              if (boss.defeated) {
                io.to('leaderboard').emit('boss:defeated', { boss });
              }
            }
          }
        })
        .catch(() => {}); // fail open
    }

    res.json({
      success: true,
      score: updatedScore
    });
  } catch (error) {
    // Release sync lock on error so the user isn't stuck
    if (req.user?.data?.discordId) {
      redisClient.del(`sync_lock:${req.user.data.discordId}`).catch(() => {});
    }
    next(error);
  }
};

/**
 * Get leaderboard (top scores)
 */
const getLeaderboard = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100
    const offset = parseInt(req.query.offset) || 0;
    const period = req.query.period || 'all'; // daily, weekly, monthly, all

    // Validate period
    const validPeriods = ['daily', 'weekly', 'monthly', 'all'];
    const selectedPeriod = validPeriods.includes(period) ? period : 'all';

    const scores = await getTopScoresByPeriod(selectedPeriod, limit, offset);
    const total = await getTotalScoresCount();

    res.json({
      success: true,
      scores,
      total,
      limit,
      offset,
      period: selectedPeriod
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get specific user's score
 */
const getUserScore = async (req, res, next) => {
  try {
    const { discordId } = req.params;

    const score = await getScoreByDiscordId(discordId);
    const rank = score ? await getUserRank(discordId) : null;

    // Fetch boss defeated count for trust factor
    let bossesDefeated = 0;
    if (score) {
      try {
        bossesDefeated = await getDefeatedBossCount(discordId);
      } catch (e) { /* non-critical */ }
    }

    // Compute trust factor for this user
    let trust = null;
    if (score) {
      const full = computeTrustFactor(score.game_state, score.created_at, bossesDefeated);
      trust = { trustScore: full.score, trustTier: full.tier, trustIcon: full.tierIcon, trustColor: full.tierColor, trustPenalties: full.penalties };
    }

    res.json({
      success: true,
      score,
      rank,
      bossesDefeated,
      ...trust
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get authenticated user's score + game state
 */
const getFullState = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const state = await getGameStateModel(discordId);

    res.json({
      success: true,
      score: state ? state.score : 0,
      gameState: state ? state.game_state : null
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Save authenticated user's game state
 */
const saveFullState = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { gameState, score } = req.body;

    // Check _adminVersion — reject stale client saves
    const existing = await pool.query('SELECT game_state FROM scores WHERE discord_id = $1', [discordId]);
    const serverVersion = existing.rows[0]?.game_state?._adminVersion || 0;
    const clientVersion = gameState?._adminVersion || 0;
    if (serverVersion > clientVersion) {
      return res.status(409).json({ error: 'State outdated', refreshRequired: true });
    }

    // Detect prestige/ascension before saving (compare old vs new state)
    const oldState = existing.rows[0]?.game_state || {};
    const oldPrestige = oldState.prestigeLevel || 0;
    const oldAscension = oldState.ascensionLevel || 0;
    const newPrestige = gameState?.prestigeLevel || 0;
    const newAscension = gameState?.ascensionLevel || 0;

    const result = await saveGameStateModel(discordId, gameState, score);

    // Invalidate leaderboard cache when score is explicitly set (prestige/ascension reset)
    if (score !== undefined && score !== null) {
      await invalidate('scores:leaderboard:*');
    }

    // Broadcast activity events for prestige/ascension
    try {
      const io = getIO();
      if (io) {
        const username = req.user.data.username || 'Unknown';
        if (newPrestige > oldPrestige) {
          const entry = { type: 'prestige', username, level: newPrestige, icon: '⭐', message: `${username} reached Prestige ${newPrestige}`, time: Date.now() };
          io.to('leaderboard').emit('activity', entry);
          pushActivity(entry);
        }
        if (newAscension > oldAscension) {
          const entry = { type: 'ascension', username, level: newAscension, icon: '🌟', message: `${username} reached Ascension ${newAscension}`, time: Date.now() };
          io.to('leaderboard').emit('activity', entry);
          pushActivity(entry);
        }
      }
    } catch (e) {
      logger.warn('Activity broadcast failed', { error: e.message });
    }

    res.json({
      success: true,
      score: result.score,
      gameState: result.game_state
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get speedrun leaderboard — fastest time to reach infinity
 */
const getSpeedrunLeaderboard = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const entries = await getSpeedrunLeaderboardModel(limit, offset);

    res.json({
      success: true,
      entries,
      limit,
      offset
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get ascension leaderboard — highest ascension levels
 */
const getAscensionLeaderboard = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 15, 50);
    const offset = parseInt(req.query.offset) || 0;

    const entries = await getAscensionLeaderboardModel(limit, offset);

    res.json({
      success: true,
      entries,
      limit,
      offset
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Claim pending web donations (bot only)
 * Returns the accumulated amount and resets the counter
 */
const claimWebDonations = async (req, res, next) => {
  try {
    const amount = await redisClient.get('lottery:web_donations');
    if (!amount || parseInt(amount) <= 0) {
      return res.json({ success: true, amount: 0 });
    }
    await redisClient.set('lottery:web_donations', '0');
    res.json({ success: true, amount: parseInt(amount) });
  } catch (error) {
    next(error);
  }
};

/**
 * Get gambling leaderboard — net profit/loss from gambling
 */
const getGamblingLeaderboard = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const entries = await getGamblingLeaderboardModel(limit, offset);

    res.json({
      success: true,
      entries,
      limit,
      offset
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  addToScore,
  getLeaderboard,
  getUserScore,
  getFullState,
  saveFullState,
  getSpeedrunLeaderboard,
  getAscensionLeaderboard,
  getGamblingLeaderboard,
  claimWebDonations
};

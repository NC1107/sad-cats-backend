const {
  addToScore: addToScoreModel,
  getTopScoresByPeriod,
  getScoreByDiscordId,
  getUserRank,
  getTotalScoresCount,
  getGameState: getGameStateModel,
  saveGameState: saveGameStateModel,
  StaleAdminVersionError,
  getSpeedrunLeaderboard: getSpeedrunLeaderboardModel,
  getAscensionLeaderboard: getAscensionLeaderboardModel,
  getGamblingLeaderboard: getGamblingLeaderboardModel
} = require('../models/score.model');
const pool = require('../config/database');
const { applyDamage: applyBossDamage, applyDamageToCurrentBoss, getDefeatedBossCount } = require('../models/boss.model');
const { getIO, pushActivity } = require('../socket');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');
const { computeTrustFactor } = require('../services/trust.service');
const {
  computeMaxDelta,
  computeMaxClickDamage,
  validateMonotonicity,
  recordAnomaly,
} = require('../services/score-validation.service');

/**
 * Atomically add to (or subtract from) a user's score
 * Supports both authenticated (web) and unauthenticated (Discord bot) requests
 */
const addToScore = async (req, res, next) => {
  try {
    const { delta, discordId, username, avatarUrl, cps, clickDamage, bossId, allowNegative, source } = req.body;

    // Anti-cheat: reject if CPS exceeds threshold. Also persist the rejection
    // to score_anomalies (severity=hard) so the soak dashboard can see how
    // often it fires for whom — issue #1 Phase 1.
    if (cps && cps > 17) {
      const cheatDiscordId = discordId || req.user?.data?.discordId;
      if (cheatDiscordId) {
        recordAnomaly(cheatDiscordId, 'cps_rejected', {
          severity: 'hard',
          payload: { cps },
        });
      }
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

      // Server-side soft-cap validation (computeMaxDelta in score-validation.service).
      // The earnings ceiling is now real: the frontend persists derived income stats
      // (catsPerSecond/clickPower/…) so computeMaxDelta can compute perSec from
      // unforgeable-ish persisted state. Elapsed-time anchor is `updated_at`
      // (server-controlled). We run OBSERVE-ONLY: record an anomaly when a delta
      // exceeds the ceiling but DO NOT clamp/reject yet — flipping to enforcement
      // happens after a soak confirms the formula produces ~zero false positives for
      // legitimate play (see ANTI_CHEAT_PLAN.md). Serving the full delta keeps this
      // change zero-risk for legit players.
      let validatedDelta = delta;
      if (delta > 0) {
        try {
          const existing = await pool.query(
            'SELECT game_state, updated_at FROM scores WHERE discord_id = $1',
            [user.discordId]
          );
          const row = existing.rows[0];
          const gs = row?.game_state || {};
          const anchorTs = row?.updated_at;
          const lastSyncMs = anchorTs ? new Date(anchorTs).getTime() : Date.now();
          const elapsedSec = Math.min(Math.max(0, (Date.now() - lastSyncMs) / 1000), 86400 * 3);
          const maxDelta = computeMaxDelta(gs, elapsedSec);
          if (maxDelta > 0 && delta > maxDelta) {
            recordAnomaly(user.discordId, 'delta_exceeds_max', {
              delta,
              maxDelta,
              elapsedSec: Math.round(elapsedSec),
              // soft today (observe-only). Mark the egregious cases hard so the soak
              // dashboard can separate "buff stacking near the cap" from "obvious forgery".
              severity: delta > maxDelta * 10 ? 'hard' : 'soft',
              payload: { ratio: maxDelta > 0 ? delta / maxDelta : null, enforced: false },
            });
          }
        } catch (e) {
          // Non-blocking — don't fail score update for validation
          logger.warn('Score-delta validation failed', { error: e.message });
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

    logger.info('Score updated', { discordId: scoreData.discordId, delta, source: req.user ? 'web' : 'bot' });

    // Non-blocking boss damage: only active clicks deal damage
    let bossDmg = clickDamage && clickDamage > 0 ? clickDamage : 0;
    if (bossDmg > 0 && scoreData.discordId) {
      // Anti-cheat: clamp clickDamage so a forged value can't one-shot the shared
      // community boss. Boss damage can't legitimately exceed a generous multiple of
      // the score earned in the same window (both come from clicks). Clamp + record.
      const maxClickDamage = computeMaxClickDamage(delta);
      if (bossDmg > maxClickDamage) {
        recordAnomaly(scoreData.discordId, 'click_damage_clamped', {
          severity: 'hard',
          payload: { clickDamage: bossDmg, maxClickDamage, delta },
        });
        bossDmg = maxClickDamage;
      }
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
    const clientVersion = gameState?._adminVersion || 0;

    // Pre-read for prestige/ascension diffing (used by the activity broadcaster below).
    // The version guard itself is enforced inside saveGameStateModel's UPDATE WHERE
    // clause — that's atomic with the write, so an admin bump between this read and
    // the save no longer silently overwrites the admin's change. The pre-read here is
    // only informational; a stale value just means we miss broadcasting an activity
    // event on the rejected save, which is a non-issue.
    const existing = await pool.query('SELECT game_state FROM scores WHERE discord_id = $1', [discordId]);
    const oldState = existing.rows[0]?.game_state || {};
    const oldPrestige = oldState.prestigeLevel || 0;
    const oldAscension = oldState.ascensionLevel || 0;
    const newPrestige = gameState?.prestigeLevel || 0;
    const newAscension = gameState?.ascensionLevel || 0;

    // Anti-cheat (Phase 1): monotonicity check against the persisted state.
    // Fires anomaly records but does NOT reject — Phase 3 will flip hard
    // violations to 422 after a one-week soak (see ANTI_CHEAT_PLAN.md).
    try {
      const { violations } = validateMonotonicity(oldState, gameState || {});
      for (const v of violations) {
        recordAnomaly(discordId, v.kind, { severity: v.severity, payload: v.payload });
      }
    } catch (e) {
      logger.warn('Monotonicity validation failed', { error: e.message, discordId });
    }

    let result;
    try {
      result = await saveGameStateModel(discordId, gameState, score, clientVersion);
    } catch (e) {
      if (e instanceof StaleAdminVersionError) {
        return res.status(409).json({ error: 'State outdated', refreshRequired: true });
      }
      throw e;
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

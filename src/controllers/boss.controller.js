const bossModel = require('../models/boss.model');
const pool = require('../config/database');
const logger = require('../utils/logger');

/**
 * Get today's bosses + optional user contributions + active buff
 */
const getBosses = async (req, res, next) => {
  try {
    const rawBosses = await bossModel.getDailyBosses();
    const bosses = rawBosses.map((boss) => {
      const spec = bossModel.getBossBuffSpec(boss);
      return {
        ...boss,
        buff_type: spec.buffType,
        buff_multiplier: spec.buffMultiplier,
        buff_label: spec.buffLabel,
        buff_minutes: spec.buffMinutes,
      };
    });
    let userContributions = {};
    let activeBuffs = [];

    const discordId = req.user?.data?.discordId;
    if (discordId && bosses.length > 0) {
      const bossIds = bosses.map(b => b.id);
      [userContributions, activeBuffs] = await Promise.all([
        bossModel.getUserContributions(bossIds, discordId),
        bossModel.getActiveBuffs(discordId)
      ]);
    }

    res.json({
      success: true,
      bosses,
      userContributions,
      activeBuffs
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get top contributors for a specific boss
 */
const getContributors = async (req, res, next) => {
  try {
    const { bossId } = req.query;
    if (!bossId) {
      return res.json({ success: true, contributors: [] });
    }

    const contributors = await bossModel.getContributors(bossId);
    res.json({ success: true, contributors });
  } catch (error) {
    next(error);
  }
};

/**
 * Claim buff from a defeated boss
 */
const claimReward = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { bossId } = req.body;

    if (!bossId) {
      return res.status(400).json({ success: false, error: 'bossId required' });
    }

    const result = await bossModel.claimReward(bossId, discordId);
    if (!result) {
      return res.status(400).json({ success: false, error: 'Boss not defeated or no contribution found' });
    }
    if (result.alreadyClaimed) {
      return res.json({
        success: true,
        alreadyClaimed: true,
        buffExpiresAt: result.buffExpiresAt,
        buffMinutes: result.buffMinutes,
        buffType: result.buffType,
        buffMultiplier: result.buffMultiplier,
        buffLabel: result.buffLabel,
      });
    }

    logger.info('Boss buff claimed', { discordId, bossId, buffExpiresAt: result.buffExpiresAt, buffMinutes: result.buffMinutes });

    // Include any toy drops from this boss for this user
    let toyDrops = [];
    try {
      const toyResult = await pool.query(
        'SELECT toy_type, quality_name FROM inventory_toys WHERE discord_id = $1 AND source_boss_id = $2',
        [discordId, bossId]
      );
      toyDrops = toyResult.rows;
    } catch (_) { /* non-critical */ }

    res.json({
      success: true,
      buffExpiresAt: result.buffExpiresAt,
      buffMinutes: result.buffMinutes,
      buffType: result.buffType,
      buffMultiplier: result.buffMultiplier,
      buffLabel: result.buffLabel,
      toyDrops,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get active boss buff for authenticated user
 */
const getBuff = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const [buffs, bossesDefeated] = await Promise.all([
      bossModel.getActiveBuffs(discordId),
      bossModel.getDefeatedBossCount(discordId)
    ]);
    res.json({ success: true, buffs, bossesDefeated });
  } catch (error) {
    next(error);
  }
};

const VOTE_THRESHOLD = 5;
const VOTE_COOLDOWN_SEC = 1800; // 30 minutes

/**
 * Vote to spawn a boss (5 votes triggers spawn, 30min cooldown)
 */
const voteBossSpawn = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { redisClient } = require('../config/redis');

    // Check cooldown
    const cooldownTTL = await redisClient.ttl('boss_vote:cooldown');
    if (cooldownTTL > 0) {
      const voteCount = await redisClient.sCard('boss_vote:voters');
      return res.json({ success: true, cooldown: true, cooldownSeconds: cooldownTTL, voteCount: Number(voteCount), needed: VOTE_THRESHOLD });
    }

    // Add vote
    await redisClient.sAdd('boss_vote:voters', discordId);
    const voteCount = Number(await redisClient.sCard('boss_vote:voters'));

    // Broadcast vote update
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) io.to('leaderboard').emit('boss:vote_update', { voteCount, needed: VOTE_THRESHOLD });
    } catch {}

    if (voteCount >= VOTE_THRESHOLD) {
      // Spawn a boss using same logic as surge spawn
      const dateKey = bossModel.getTodayKey();
      const existing = await pool.query('SELECT boss_name FROM cat_bosses WHERE spawn_date = $1', [dateKey]);
      const usedNames = new Set(existing.rows.map(r => r.boss_name));
      const available = bossModel.BOSS_NAMES.filter(b => !usedNames.has(b.name));

      if (available.length === 0) {
        await redisClient.del('boss_vote:voters');
        return res.json({ success: true, spawned: false, error: 'All bosses already spawned today', voteCount: 0, needed: VOTE_THRESHOLD });
      }

      // Weighted random pick
      const totalWeight = available.reduce((sum, b) => sum + (Number(b.rarityWeight) || 1), 0);
      let roll = Math.random() * totalWeight;
      let picked = available[available.length - 1];
      for (const b of available) {
        roll -= (Number(b.rarityWeight) || 1);
        if (roll <= 0) { picked = b; break; }
      }

      // Pick level
      const levelWeights = [0.60, 0.83, 0.93, 0.98, 1.0];
      const lvlRoll = Math.random();
      let levelIdx = levelWeights.findIndex(lw => lvlRoll < lw);
      if (levelIdx === -1) levelIdx = 4;
      const lvl = bossModel.BOSS_LEVELS[levelIdx];
      const hpRange = bossModel.getScaledHpRange(lvl.level, picked.name);
      const hp = String(Math.floor(Math.random() * (hpRange.maxHP - hpRange.minHP + 1)) + hpRange.minHP);

      const result = await pool.query(
        `INSERT INTO cat_bosses (week_key, boss_name, boss_emoji, max_hp, current_hp, reward_pool, boss_level, buff_duration_minutes, spawn_date, source)
         VALUES ($1, $2, $3, $4::NUMERIC, $4::NUMERIC, 0, $5, $6, $7, 'vote')
         ON CONFLICT (spawn_date, boss_name) DO NOTHING RETURNING *`,
        [null, picked.name, picked.emoji, hp, lvl.level, lvl.buffMinutes, dateKey]
      );

      // Clear votes, set cooldown
      await redisClient.del('boss_vote:voters');
      await redisClient.set('boss_vote:cooldown', '1', { EX: VOTE_COOLDOWN_SEC });

      if (result.rows.length > 0) {
        logger.info('Vote boss spawned', { name: picked.name, level: lvl.level, hp });
        try {
          const { getIO } = require('../socket');
          const io = getIO();
          if (io) {
            io.to('leaderboard').emit('boss:vote_spawn', { boss: result.rows[0] });
            io.to('leaderboard').emit('boss:vote_update', { voteCount: 0, needed: VOTE_THRESHOLD, cooldownSeconds: VOTE_COOLDOWN_SEC });
          }
        } catch {}
      }

      return res.json({ success: true, spawned: true, boss: result.rows[0], voteCount: 0, needed: VOTE_THRESHOLD, cooldownSeconds: VOTE_COOLDOWN_SEC });
    }

    res.json({ success: true, voteCount, needed: VOTE_THRESHOLD });
  } catch (error) {
    next(error);
  }
};

/**
 * Get current vote status
 */
const getVoteStatus = async (req, res, next) => {
  try {
    const { redisClient } = require('../config/redis');
    const discordId = req.user?.data?.discordId;

    const cooldownTTL = await redisClient.ttl('boss_vote:cooldown');
    const cooldown = cooldownTTL > 0;
    const voteCount = cooldown ? 0 : Number(await redisClient.sCard('boss_vote:voters'));
    const hasVoted = discordId ? await redisClient.sIsMember('boss_vote:voters', discordId) : false;

    res.json({ success: true, voteCount, needed: VOTE_THRESHOLD, cooldown, cooldownSeconds: Math.max(0, cooldownTTL), hasVoted });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getBoss: getBosses,
  getBosses,
  getContributors,
  claimReward,
  getBuff,
  voteBossSpawn,
  getVoteStatus,
};

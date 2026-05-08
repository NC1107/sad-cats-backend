const pool = require('../config/database');
const logger = require('../utils/logger');
const { InternalError } = require('../utils/errors');
const { redisClient } = require('../config/redis');
const toyService = require('../services/toy.service');
const inventoryModel = require('../models/inventory.model');

// Boss names pool
const BOSS_NAMES = [
  { name: 'Keyboard Gremlin Cat', emoji: '😾', buffType: 'click', baseMultiplier: 1.08, baseDurationMinutes: 30, hpScale: 0.8, rarityWeight: 19 },
  { name: 'Cursed Reaction Kitty', emoji: '🐆', buffType: 'auto', baseMultiplier: 1.1, baseDurationMinutes: 45, hpScale: 0.9, rarityWeight: 17 },
  { name: 'Cringe Compilation Cougar', emoji: '🐍', buffType: 'passive', baseMultiplier: 1.14, baseDurationMinutes: 60, hpScale: 1.0, rarityWeight: 14 },
  { name: 'Doomscroll Lynx', emoji: '🌪️', buffType: 'all', baseMultiplier: 1.22, baseDurationMinutes: 90, hpScale: 1.1, rarityWeight: 12 },
  { name: 'Lagspike Leopard', emoji: '🧶', buffType: 'click', baseMultiplier: 1.3, baseDurationMinutes: 150, hpScale: 1.2, rarityWeight: 10 },
  { name: 'Nullpointer Panther', emoji: '🕳️', buffType: 'auto', baseMultiplier: 1.38, baseDurationMinutes: 240, hpScale: 1.35, rarityWeight: 8 },
  { name: 'Cache-Eater Chimera Cat', emoji: '🦁', buffType: 'passive', baseMultiplier: 1.48, baseDurationMinutes: 480, hpScale: 1.5, rarityWeight: 7 },
  { name: 'Nebula Purrsecutor', emoji: '💅', buffType: 'all', baseMultiplier: 1.6, baseDurationMinutes: 720, hpScale: 1.7, rarityWeight: 6 },
  { name: 'Event Horizon Maine Coon', emoji: '🌌', buffType: 'all', baseMultiplier: 1.75, baseDurationMinutes: 1080, hpScale: 1.9, rarityWeight: 5 },
  { name: 'Last Meowsingularity', emoji: '👁️', buffType: 'all', baseMultiplier: 2.0, baseDurationMinutes: 1440, hpScale: 2.2, rarityWeight: 2 },
];

// Boss levels: level -> HP range + buff duration
const BOSS_LEVELS = [
  { level: 1, minHP: 50_000_000_000, maxHP: 250_000_000_000, buffMinutes: 15 },
  { level: 2, minHP: 250_000_000_000, maxHP: 1_200_000_000_000, buffMinutes: 45 },
  { level: 3, minHP: 1_200_000_000_000, maxHP: 8_000_000_000_000, buffMinutes: 180 },
  { level: 4, minHP: 8_000_000_000_000, maxHP: 60_000_000_000_000, buffMinutes: 720 },
  { level: 5, minHP: 600_000_000_000_000, maxHP: 4_000_000_000_000_000, buffMinutes: 2880 },
];

const LEVEL_POWER_MULTIPLIER = {
  1: 1.0,
  2: 1.05,
  3: 1.12,
  4: 1.22,
  5: 1.35,
};

const LEVEL_DURATION_MULTIPLIER = {
  1: 1.0,
  2: 1.15,
  3: 1.35,
  4: 1.65,
  5: 2.0,
};

const MAX_BUFF_MINUTES = 72 * 60;

const round2 = (n) => Math.round(n * 100) / 100;

const pickWeightedUniqueBosses = (count, rng) => {
  const pool = [...BOSS_NAMES];
  const selected = [];

  while (selected.length < count && pool.length > 0) {
    const totalWeight = pool.reduce((sum, boss) => sum + (Number(boss.rarityWeight) || 1), 0);
    let roll = rng() * totalWeight;
    let pickIndex = pool.length - 1;

    for (let i = 0; i < pool.length; i++) {
      roll -= (Number(pool[i].rarityWeight) || 1);
      if (roll <= 0) {
        pickIndex = i;
        break;
      }
    }

    selected.push(pool[pickIndex]);
    pool.splice(pickIndex, 1);
  }

  return selected;
};

const getBossProfile = (bossName) => BOSS_NAMES.find(b => b.name === bossName) || BOSS_NAMES[0];

const getScaledHpRange = (level, bossName) => {
  const lvl = BOSS_LEVELS[Math.min(5, Math.max(1, parseInt(level, 10) || 1)) - 1] || BOSS_LEVELS[0];
  const profile = getBossProfile(bossName);
  const scale = Number(profile.hpScale) || 1;
  const minHP = Math.max(1, Math.floor(lvl.minHP * scale));
  const maxHP = Math.max(minHP + 1, Math.floor(lvl.maxHP * scale));
  return { minHP, maxHP };
};

const formatBuffLabel = (type, multiplier) => {
  const v = round2(multiplier);
  const x = Number.isInteger(v) ? `${v}` : `${v}`;
  if (type === 'click') return `${x}x click income`;
  if (type === 'passive') return `${x}x passive income`;
  if (type === 'auto') return `${x}x auto-click income`;
  return `${x}x all income`;
};

const getBossBuffSpec = (boss) => {
  const profile = getBossProfile(boss?.boss_name);
  const level = Math.min(5, Math.max(1, parseInt(boss?.boss_level, 10) || 1));
  const levelBuffMinutes = parseInt(boss?.buff_duration_minutes, 10) || (BOSS_LEVELS[level - 1]?.buffMinutes || 10);
  const powerMult = LEVEL_POWER_MULTIPLIER[level] || 1;
  const durationMult = LEVEL_DURATION_MULTIPLIER[level] || 1;

  const buffMultiplier = round2((profile.baseMultiplier || 1.25) * powerMult);
  const baseMinutes = Math.max(profile.baseDurationMinutes || 30, levelBuffMinutes);
  const buffMinutes = Math.min(MAX_BUFF_MINUTES, Math.max(10, Math.round(baseMinutes * durationMult)));
  const buffType = profile.buffType || 'all';
  const buffLabel = formatBuffLabel(buffType, buffMultiplier);

  return {
    buffType,
    buffMultiplier,
    buffMinutes,
    buffLabel,
  };
};

// ---------- Seeded PRNG ----------

/**
 * Simple seeded PRNG (mulberry32). Returns a function that produces 0..1 floats.
 */
const seedRng = (seed) => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  let s = Math.abs(h) | 0;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};

// ---------- Daily schedule generation ----------

/**
 * Get today's date key (YYYY-MM-DD) in UTC
 */
const getTodayKey = () => {
  const d = new Date();
  return d.toISOString().slice(0, 10);
};

/**
 * Deterministically generate the daily boss schedule for a given date.
 * 4 time windows (00:00, 06:00, 12:00, 18:00 UTC), each with 1 boss minimum
 * and a 25% chance for a 2nd boss per window. Returns an array of boss specs.
 */
const generateDailySchedule = (dateKey) => {
  const SPAWN_HOURS = [0, 6, 12, 18];
  const levelWeights = [0.60, 0.83, 0.93, 0.98, 1.0];
  const usedNames = new Set();
  const bosses = [];

  for (let w = 0; w < SPAWN_HOURS.length; w++) {
    const rng = seedRng(dateKey + '_w' + w);
    // Each window: 1 boss guaranteed, 25% chance for a 2nd
    const count = rng() < 0.25 ? 2 : 1;

    for (let i = 0; i < count; i++) {
      // Pick a unique boss name (re-roll on collision, up to 10 attempts)
      let picked = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidates = pickWeightedUniqueBosses(1, rng);
        if (candidates.length > 0 && !usedNames.has(candidates[0].name)) {
          picked = candidates[0];
          break;
        }
      }
      if (!picked) continue; // Skip if can't find unique boss
      usedNames.add(picked.name);

      // Pick level
      const lvlRoll = rng();
      let levelIdx = levelWeights.findIndex(lw => lvlRoll < lw);
      if (levelIdx === -1) levelIdx = 4;
      const lvl = BOSS_LEVELS[levelIdx];
      const hpRange = getScaledHpRange(lvl.level, picked.name);
      const hp = String(Math.floor(rng() * (hpRange.maxHP - hpRange.minHP + 1)) + hpRange.minHP);

      bosses.push({
        boss_name: picked.name,
        boss_emoji: picked.emoji,
        boss_level: lvl.level,
        buff_duration_minutes: lvl.buffMinutes,
        max_hp: hp,
        spawn_hour: SPAWN_HOURS[w],
      });
    }
  }

  return bosses;
};

// ---------- Toy distribution on defeat ----------

/**
 * Fire-and-forget toy distribution after boss defeat.
 * Gets all contributors, generates drops, inserts into inventory.
 */
const distributeToys = async (bossId, boss) => {
  try {
    // Idempotency check — skip if toys already distributed for this boss
    const existing = await pool.query(
      'SELECT 1 FROM boss_toy_distributions WHERE boss_id = $1',
      [bossId]
    );
    if (existing.rows.length > 0) {
      logger.info('Toys already distributed, skipping', { bossId });
      return;
    }
    // Record distribution before doing work (claim the slot)
    await pool.query(
      'INSERT INTO boss_toy_distributions (boss_id, distributed_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING',
      [bossId]
    );

    const profile = getBossProfile(boss.boss_name);
    const bossLevel = parseInt(boss.boss_level, 10) || 1;

    // Get all contributors sorted by damage
    const contribResult = await pool.query(
      `SELECT discord_id, damage_dealt FROM boss_contributions
       WHERE boss_id = $1 AND damage_dealt > 0
       ORDER BY damage_dealt DESC`,
      [bossId]
    );
    if (contribResult.rows.length === 0) return;

    const drops = toyService.determineDrops(contribResult.rows, {
      name: boss.boss_name,
      rarityWeight: profile.rarityWeight,
      bossLevel,
    });

    if (drops.length === 0) return;

    // Filter to contributors who have a scores row (FK constraint)
    const validCheck = await pool.query(
      'SELECT discord_id FROM scores WHERE discord_id = ANY($1)',
      [drops.map(d => d.discordId)]
    );
    const validIds = new Set(validCheck.rows.map(r => r.discord_id));

    // Insert per-user so one failure doesn't kill the whole batch
    const allToys = [];
    for (const drop of drops) {
      if (!validIds.has(drop.discordId)) continue;
      const currentCount = await inventoryModel.getToyCount(drop.discordId);
      const room = toyService.MAX_TOYS_PER_USER - currentCount;
      if (room <= 0) continue;
      const toysToInsert = drop.toys.slice(0, room).map(t => ({
        ...t,
        discord_id: drop.discordId,
        source_boss_id: bossId,
      }));
      try {
        await inventoryModel.insertToys(toysToInsert);
        allToys.push(...toysToInsert);
      } catch (err) {
        logger.error('Failed to insert toys for user', { discordId: drop.discordId, error: err.message });
      }
    }

    if (allToys.length > 0) {
      logger.info('Toys distributed', { bossId, bossName: boss.boss_name, toyCount: allToys.length, recipients: drops.length });
    }

    // Emit socket event for real-time notifications (broadcast to leaderboard room)
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) {
        const dropsSummary = drops.map(drop => {
          const userToys = allToys.filter(t => t.discord_id === drop.discordId);
          return {
            discordId: drop.discordId,
            toys: userToys.map(t => ({
              toy_type: t.toy_type,
              tier: t.tier,
              quality: t.quality,
              quality_name: t.quality_name,
            })),
          };
        }).filter(d => d.toys.length > 0);

        if (dropsSummary.length > 0) {
          io.to('leaderboard').emit('boss:toys_distributed', {
            bossId,
            bossName: boss.boss_name,
            drops: dropsSummary,
          });
        }
      }
    } catch (socketErr) {
      // Socket emit failure is non-critical
      logger.error('Error emitting toy socket events', { error: socketErr.message });
    }
  } catch (error) {
    logger.error('Error distributing toys', { error: error.message, bossId });
  }
};

// ---------- Core functions ----------

/**
 * Get or create today's bosses. Lazy-creates on first call of the day.
 * Respects bossSpawningEnabled flag (won't create NEW bosses if disabled,
 * but returns existing ones for the day).
 */
const getDailyBosses = async () => {
  const dateKey = getTodayKey();
  const currentHour = new Date().getUTCHours();

  try {
    // Generate today's full schedule and filter to arrived windows
    const schedule = generateDailySchedule(dateKey);
    const arrivedSpecs = schedule.filter(s => currentHour >= s.spawn_hour);

    // Check if spawning is enabled before creating new bosses
    const spawningEnabled = await redisClient.get('config:bossSpawningEnabled');

    // Try to insert any arrived bosses that don't exist yet
    if (spawningEnabled !== 'false') {
      for (const spec of arrivedSpecs) {
        const result = await pool.query(
          `INSERT INTO cat_bosses (week_key, boss_name, boss_emoji, max_hp, current_hp, reward_pool, boss_level, buff_duration_minutes, spawn_date)
           VALUES ($1, $2, $3, $4::BIGINT, $4::BIGINT, 0, $5, $6, $7)
           ON CONFLICT (spawn_date, boss_name) DO NOTHING
           RETURNING *`,
          [null, spec.boss_name, spec.boss_emoji, spec.max_hp, spec.boss_level, spec.buff_duration_minutes, dateKey]
        );
        if (result.rows.length > 0) {
          logger.info('New boss created', { dateKey, name: spec.boss_name, level: spec.boss_level, hp: spec.max_hp, spawnHour: spec.spawn_hour });
        }
      }
    }

    // Always return all existing bosses for today
    const existing = await pool.query(
      'SELECT * FROM cat_bosses WHERE spawn_date = $1 ORDER BY id ASC',
      [dateKey]
    );
    return existing.rows;
  } catch (error) {
    logger.error('Error getting/creating daily bosses', { error: error.message });
    throw new InternalError('Failed to get bosses');
  }
};

/**
 * Backward-compat wrapper: returns the first alive boss from today
 */
const getOrCreateCurrentBoss = async () => {
  const bosses = await getDailyBosses();
  // Prefer first non-defeated boss
  return bosses.find(b => !b.defeated) || bosses[0] || null;
};

/**
 * Apply damage to a specific boss by ID (non-blocking, fail-open)
 */
const applyDamage = async (bossId, discordId, username, damage) => {
  try {
    // Verify boss exists and is alive
    const bossResult = await pool.query(
      'SELECT * FROM cat_bosses WHERE id = $1 AND NOT defeated',
      [bossId]
    );
    const boss = bossResult.rows[0];
    if (!boss) return null;

    // Upsert contribution
    await pool.query(
      `INSERT INTO boss_contributions (boss_id, discord_id, username, damage_dealt, updated_at)
       VALUES ($1, $2, $3, $4::BIGINT, NOW())
       ON CONFLICT (boss_id, discord_id)
       DO UPDATE SET
         damage_dealt = boss_contributions.damage_dealt + $4::BIGINT,
         username = $3,
         updated_at = NOW()`,
      [bossId, discordId, username, damage]
    );

    // Atomically reduce HP and detect defeat
    const result = await pool.query(
      `UPDATE cat_bosses
       SET current_hp = GREATEST(0, current_hp - $1::BIGINT),
           defeated = CASE WHEN GREATEST(0, current_hp - $1::BIGINT) = 0 THEN TRUE ELSE defeated END,
           defeated_at = CASE WHEN GREATEST(0, current_hp - $1::BIGINT) = 0 AND NOT defeated THEN NOW() ELSE defeated_at END
       WHERE id = $2 AND NOT defeated
       RETURNING *`,
      [damage, bossId]
    );

    const updated = result.rows[0] || boss;

    // Fire-and-forget toy distribution on defeat
    if (updated.defeated && result.rows[0]) {
      distributeToys(bossId, updated).catch(err =>
        logger.error('Toy distribution failed', { error: err.message, bossId })
      );
    }

    return updated;
  } catch (error) {
    logger.error('Error applying boss damage', { error: error.message, discordId, bossId });
    return null; // fail open
  }
};

/**
 * Legacy wrapper — routes damage to first alive boss
 */
const applyDamageToCurrentBoss = async (discordId, username, damage) => {
  const boss = await getOrCreateCurrentBoss();
  if (!boss || boss.defeated) return boss;
  return applyDamage(boss.id, discordId, username, damage);
};

/**
 * Get the current boss (without creating)
 */
const getCurrentBoss = async () => {
  try {
    return await getOrCreateCurrentBoss();
  } catch (error) {
    logger.error('Error getting current boss', { error: error.message });
    return null;
  }
};

/**
 * Get top contributors for a boss
 */
const getContributors = async (bossId, limit = 20) => {
  try {
    const result = await pool.query(
      `SELECT discord_id, username, damage_dealt, reward_claimed, buff_expires_at
       FROM boss_contributions
       WHERE boss_id = $1
       ORDER BY damage_dealt DESC
       LIMIT $2`,
      [bossId, limit]
    );
    return result.rows;
  } catch (error) {
    logger.error('Error getting contributors', { error: error.message });
    throw new InternalError('Failed to get contributors');
  }
};

/**
 * Get a specific user's contribution for a boss
 */
const getUserContribution = async (bossId, discordId) => {
  try {
    const result = await pool.query(
      `SELECT discord_id,
              username,
              damage_dealt,
              COALESCE(reward_claimed, FALSE) AS reward_claimed,
              buff_expires_at
       FROM boss_contributions
       WHERE boss_id = $1 AND discord_id = $2`,
      [bossId, discordId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error('Error getting user contribution', { error: error.message });
    return null;
  }
};

/**
 * Get user contributions for multiple bosses at once
 */
const getUserContributions = async (bossIds, discordId) => {
  try {
    if (!bossIds.length) return {};
    const result = await pool.query(
      `SELECT boss_id,
              discord_id,
              username,
              damage_dealt,
              COALESCE(reward_claimed, FALSE) AS reward_claimed,
              buff_expires_at
       FROM boss_contributions
       WHERE boss_id = ANY($1) AND discord_id = $2`,
      [bossIds, discordId]
    );
    const map = {};
    for (const row of result.rows) {
      map[row.boss_id] = row;
    }
    return map;
  } catch (error) {
    logger.error('Error getting user contributions', { error: error.message });
    return {};
  }
};

/**
 * Claim buff reward for a defeated boss.
 * Buff duration comes from the boss's buff_duration_minutes column.
 */
const claimReward = async (bossId, discordId) => {
  try {
    const bossResult = await pool.query(
      'SELECT * FROM cat_bosses WHERE id = $1 AND defeated = TRUE',
      [bossId]
    );
    if (bossResult.rows.length === 0) return null;
    const boss = bossResult.rows[0];

    const contribResult = await pool.query(
      'SELECT * FROM boss_contributions WHERE boss_id = $1 AND discord_id = $2',
      [bossId, discordId]
    );
    if (contribResult.rows.length === 0) return null;
    const contrib = contribResult.rows[0];
    if (contrib.reward_claimed === true) {
      return {
        alreadyClaimed: true,
        buffExpiresAt: contrib.buff_expires_at,
        buffMinutes: contrib.buff_duration_minutes || boss.buff_duration_minutes,
        buffType: contrib.buff_type || null,
        buffMultiplier: contrib.buff_multiplier ? Number(contrib.buff_multiplier) : null,
        buffLabel: contrib.buff_label || null,
      };
    }

    const spec = getBossBuffSpec(boss);
    const buffMs = spec.buffMinutes * 60 * 1000;
    const buffExpiresAt = new Date(Date.now() + buffMs);

    let updateResult;
    try {
      updateResult = await pool.query(
        `UPDATE boss_contributions
         SET reward_claimed = TRUE,
             buff_expires_at = $3,
             buff_type = $4,
             buff_multiplier = $5,
             buff_label = $6,
             buff_duration_minutes = $7,
             updated_at = NOW()
         WHERE boss_id = $1
           AND discord_id = $2
           AND COALESCE(reward_claimed, FALSE) = FALSE
         RETURNING reward_claimed, buff_expires_at`,
        [
          bossId,
          discordId,
          buffExpiresAt.toISOString(),
          spec.buffType,
          spec.buffMultiplier,
          spec.buffLabel,
          spec.buffMinutes,
        ]
      );
    } catch (err) {
      // Backward compatibility: old schema may not have buff metadata columns yet.
      // PostgreSQL undefined_column = 42703
      if (err?.code !== '42703') throw err;

      logger.warn('boss_contributions buff metadata columns missing; using legacy claim update', {
        discordId,
        bossId,
      });

      updateResult = await pool.query(
        `UPDATE boss_contributions
         SET reward_claimed = TRUE,
             buff_expires_at = $3,
             updated_at = NOW()
         WHERE boss_id = $1
           AND discord_id = $2
           AND COALESCE(reward_claimed, FALSE) = FALSE
         RETURNING reward_claimed, buff_expires_at`,
        [
          bossId,
          discordId,
          buffExpiresAt.toISOString(),
        ]
      );
    }

    if (updateResult.rows.length === 0) {
      const afterResult = await pool.query(
        `SELECT reward_claimed, buff_expires_at, buff_type, buff_multiplier, buff_label, buff_duration_minutes
         FROM boss_contributions
         WHERE boss_id = $1 AND discord_id = $2`,
        [bossId, discordId]
      );

      const after = afterResult.rows[0];
      if (after?.reward_claimed) {
        return {
          alreadyClaimed: true,
          buffExpiresAt: after.buff_expires_at,
          buffMinutes: after.buff_duration_minutes || boss.buff_duration_minutes,
          buffType: after.buff_type || null,
          buffMultiplier: after.buff_multiplier ? Number(after.buff_multiplier) : null,
          buffLabel: after.buff_label || null,
        };
      }

      throw new InternalError('Failed to claim reward');
    }

    return {
      buffExpiresAt: buffExpiresAt.toISOString(),
      buffMinutes: spec.buffMinutes,
      buffType: spec.buffType,
      buffMultiplier: spec.buffMultiplier,
      buffLabel: spec.buffLabel,
    };
  } catch (error) {
    logger.error('Error claiming boss reward', { error: error.message, discordId });
    throw new InternalError('Failed to claim reward');
  }
};

/**
 * Get active boss buff for a user (any recent boss) — legacy single buff
 */
const getActiveBuff = async (discordId) => {
  try {
    const result = await pool.query(
      `SELECT buff_expires_at FROM boss_contributions
       WHERE discord_id = $1 AND buff_expires_at > NOW()
       ORDER BY buff_expires_at DESC LIMIT 1`,
      [discordId]
    );
    if (result.rows.length === 0) return null;
    return { buffExpiresAt: result.rows[0].buff_expires_at };
  } catch (error) {
    logger.error('Error getting active boss buff', { error: error.message });
    return null;
  }
};

/**
 * Get ALL active boss buffs for a user (for stacking)
 */
const getActiveBuffs = async (discordId) => {
  try {
    const result = await pool.query(
      `SELECT bc.boss_id,
              bc.buff_expires_at,
              bc.buff_type,
              bc.buff_multiplier,
              bc.buff_label,
              bc.buff_duration_minutes,
              cb.boss_name,
              cb.boss_emoji,
              cb.boss_level,
              cb.buff_duration_minutes as boss_base_buff_minutes
       FROM boss_contributions bc
       LEFT JOIN cat_bosses cb ON cb.id = bc.boss_id
       WHERE bc.discord_id = $1 AND bc.buff_expires_at > NOW()
       ORDER BY buff_expires_at DESC`,
      [discordId]
    );
    return result.rows.map(r => {
      const fallbackSpec = getBossBuffSpec({
        boss_name: r.boss_name,
        boss_level: r.boss_level,
        buff_duration_minutes: r.boss_base_buff_minutes,
      });

      return {
        bossId: r.boss_id,
        bossName: r.boss_name,
        bossEmoji: r.boss_emoji,
        buffType: r.buff_type || fallbackSpec.buffType,
        buffMultiplier: r.buff_multiplier ? Number(r.buff_multiplier) : fallbackSpec.buffMultiplier,
        buffLabel: r.buff_label || fallbackSpec.buffLabel,
        buffMinutes: r.buff_duration_minutes || fallbackSpec.buffMinutes,
        buffExpiresAt: r.buff_expires_at,
      };
    });
  } catch (error) {
    logger.error('Error getting active boss buffs', { error: error.message });
    return [];
  }
};

/**
 * Count how many defeated bosses a user has contributed to
 */
const getDefeatedBossCount = async (discordId) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM boss_contributions bc
       JOIN cat_bosses cb ON cb.id = bc.boss_id
       WHERE bc.discord_id = $1 AND cb.defeated = TRUE AND bc.damage_dealt > 0`,
      [discordId]
    );
    return parseInt(result.rows[0].count) || 0;
  } catch (error) {
    logger.error('Error getting defeated boss count', { error: error.message });
    return 0;
  }
};

/**
 * Check if a surge spawn should happen based on online player count.
 * Max 2 surge spawns per day. Called every 30 minutes from server.js.
 */
const checkSurgeSpawn = async (onlineCount) => {
  const dateKey = getTodayKey();
  const surgeKey = `surge_spawns:${dateKey}`;

  try {
    const spawningEnabled = await redisClient.get('config:bossSpawningEnabled');
    if (spawningEnabled === 'false') return null;

    // Max 2 surge spawns per day
    const surgeCount = parseInt(await redisClient.get(surgeKey)) || 0;
    if (surgeCount >= 2) return null;

    // Online player threshold -> spawn chance
    let chance = 0;
    if (onlineCount >= 13) chance = 0.50;
    else if (onlineCount >= 8) chance = 0.35;
    else if (onlineCount >= 5) chance = 0.20;
    else if (onlineCount >= 3) chance = 0.10;
    else return null;

    if (Math.random() >= chance) return null;

    // Pick a boss not already spawned today
    const existing = await pool.query(
      'SELECT boss_name FROM cat_bosses WHERE spawn_date = $1',
      [dateKey]
    );
    const usedNames = new Set(existing.rows.map(r => r.boss_name));
    const available = BOSS_NAMES.filter(b => !usedNames.has(b.name));
    if (available.length === 0) return null;

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
    const lvl = BOSS_LEVELS[levelIdx];
    const hpRange = getScaledHpRange(lvl.level, picked.name);
    const hp = String(Math.floor(Math.random() * (hpRange.maxHP - hpRange.minHP + 1)) + hpRange.minHP);

    const result = await pool.query(
      `INSERT INTO cat_bosses (week_key, boss_name, boss_emoji, max_hp, current_hp, reward_pool, boss_level, buff_duration_minutes, spawn_date, source)
       VALUES ($1, $2, $3, $4::BIGINT, $4::BIGINT, 0, $5, $6, $7, 'surge')
       ON CONFLICT (spawn_date, boss_name) DO NOTHING
       RETURNING *`,
      [null, picked.name, picked.emoji, hp, lvl.level, lvl.buffMinutes, dateKey]
    );

    if (result.rows.length > 0) {
      await redisClient.set(surgeKey, String(surgeCount + 1), 'EX', 86400);
      logger.info('Surge boss spawned', {
        dateKey, name: picked.name, level: lvl.level, hp, onlineCount, surgeNumber: surgeCount + 1,
      });

      // Emit socket event
      try {
        const { getIO } = require('../socket');
        const io = getIO();
        if (io) {
          io.to('leaderboard').emit('boss:surge_spawn', { boss: result.rows[0], onlineCount });
        }
      } catch {}

      return result.rows[0];
    }
    return null;
  } catch (error) {
    logger.error('Error checking surge spawn', { error: error.message, onlineCount });
    return null;
  }
};

module.exports = {
  BOSS_NAMES,
  BOSS_LEVELS,
  getBossBuffSpec,
  getScaledHpRange,
  getTodayKey,
  generateDailySchedule,
  getDailyBosses,
  getOrCreateCurrentBoss,
  applyDamage,
  applyDamageToCurrentBoss,
  getCurrentBoss,
  getContributors,
  getUserContribution,
  getUserContributions,
  claimReward,
  getActiveBuff,
  getActiveBuffs,
  getDefeatedBossCount,
  distributeToys,
  checkSurgeSpawn,
  // Legacy compat
  getWeekKey: getTodayKey,
};

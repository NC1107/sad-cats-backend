/**
 * Trust factor computation — penalty-based, starts at 100.
 * Everyone starts trusted. Points deducted only for suspicious stats.
 * Compute-on-read, no DB writes.
 */

const TRUST_TIERS = [
  { minScore: 80, tier: 'trusted', label: 'Trusted', icon: '✓', color: 'text-green-400' },
  { minScore: 60, tier: 'moderate', label: 'Moderate', icon: '⚠', color: 'text-yellow-400' },
  { minScore: 40, tier: 'low', label: 'Low', icon: '⚠', color: 'text-orange-400' },
  { minScore: 0, tier: 'untrusted', label: 'Untrusted', icon: '✗', color: 'text-red-400' },
];

/**
 * Penalty rules — each returns a deduction (0 or positive number).
 * Conditions must be met for the deduction to apply.
 */
const PENALTY_RULES = [
  {
    key: 'highCps',
    label: 'Abnormally high click speed (>15 CPS avg)',
    test: (stats) => stats.avgCps > 15,
    deduction: 20,
  },
  {
    key: 'moderateCps',
    label: 'Suspicious click speed (>12 CPS avg)',
    test: (stats) => stats.avgCps > 12 && stats.avgCps <= 15,
    deduction: 10,
  },
  {
    key: 'lowPlaytimeHighScore',
    label: 'High earnings with very low playtime',
    test: (stats) => stats.lifetimeEarnings > 10_000_000_000 && stats.playTime < 3600,
    deduction: 15,
  },
  {
    key: 'noAchievementsHighScore',
    label: 'High earnings but few achievements unlocked',
    test: (stats) => stats.lifetimeEarnings > 1_000_000 && stats.achievements < 3,
    deduction: 20,
  },
  {
    key: 'noBossesOldAccount',
    label: 'Old account with no boss participation',
    test: (stats) => stats.accountAgeDays > 14 && stats.bossesDefeated === 0 && stats.lifetimeEarnings > 100_000,
    deduction: 10,
  },
  {
    key: 'rapidAscension',
    label: 'Ascended with very little playtime',
    test: (stats) => stats.ascensionLevel > 0 && stats.playTime < 7200,
    deduction: 15,
  },
  {
    key: 'highCombo',
    label: 'Suspiciously high combo streak (>2000)',
    test: (stats) => stats.maxCombo > 2000,
    deduction: 5,
  },
  {
    key: 'extremeCombo',
    label: 'Extreme combo (likely automation, >5000)',
    test: (stats) => stats.maxCombo > 5000,
    deduction: 10,
  },
];

/**
 * Compute trust factor from game state and metadata.
 * Starts at 100 and deducts for suspicious patterns.
 */
const computeTrustFactor = (gameState, createdAt, bossesDefeated = 0) => {
  const gs = gameState || {};
  const accountAgeDays = createdAt
    ? Math.max(0, (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const totalClicks = Number(gs.totalClicks) || 0;
  const playTime = Number(gs.totalClickTime) || 0;

  const stats = {
    accountAgeDays,
    totalClicks,
    playTime,
    avgCps: playTime > 0 ? totalClicks / playTime : 0,
    lifetimeEarnings: Number(gs.lifetimeEarnings) || 0,
    achievements: Array.isArray(gs.unlockedAchievements) ? gs.unlockedAchievements.length : 0,
    bossesDefeated: Number(bossesDefeated) || 0,
    ascensionLevel: Number(gs.ascensionLevel) || 0,
    prestigeLevel: Number(gs.prestigeLevel) || 0,
    maxCombo: Number(gs.dailyChallenges?.maxCombo) || 0,
  };

  let score = 100;
  const penalties = [];

  for (const rule of PENALTY_RULES) {
    if (rule.test(stats)) {
      score -= rule.deduction;
      penalties.push({ key: rule.key, label: rule.label, deduction: rule.deduction });
    }
  }

  score = Math.max(0, score);
  const tierInfo = TRUST_TIERS.find(t => score >= t.minScore) || TRUST_TIERS[TRUST_TIERS.length - 1];

  return {
    score,
    penalties,
    tier: tierInfo.tier,
    tierLabel: tierInfo.label,
    tierIcon: tierInfo.icon,
    tierColor: tierInfo.color,
  };
};

/**
 * Lightweight tier-only computation for leaderboard rows.
 */
const computeTrustTier = (gameState, createdAt, bossesDefeated = 0) => {
  const full = computeTrustFactor(gameState, createdAt, bossesDefeated);
  return {
    trustScore: full.score,
    trustTier: full.tier,
    trustIcon: full.tierIcon,
    trustColor: full.tierColor,
  };
};

/**
 * Async trust factor with Redis CPS history analysis.
 * Adds penalties for sustained high CPS bursts that lifetime averages miss.
 */
const computeTrustFactorAsync = async (gameState, createdAt, bossesDefeated = 0, redisClient = null, discordId = null) => {
  // Start with the sync computation
  const result = computeTrustFactor(gameState, createdAt, bossesDefeated);

  // Add Redis CPS history analysis if available
  if (redisClient && discordId) {
    try {
      const key = `cps:${discordId}`;
      const samples = await redisClient.zRange(key, 0, -1);

      if (samples.length >= 10) {
        const cpsValues = samples.map(s => {
          const parts = s.split(':');
          return parseFloat(parts[parts.length - 1]) || 0;
        });

        // Check: >20% of samples above 12 CPS
        const highCount = cpsValues.filter(v => v > 12).length;
        const highRatio = highCount / cpsValues.length;
        if (highRatio > 0.2) {
          const penalty = { key: 'sustainedHighCps', label: `${Math.round(highRatio * 100)}% of recent CPS samples above 12`, deduction: 15 };
          result.penalties.push(penalty);
          result.score -= penalty.deduction;
        }

        // Check: rolling 5-sample average > 15 CPS
        let maxRollingAvg = 0;
        for (let i = 0; i <= cpsValues.length - 5; i++) {
          const avg = cpsValues.slice(i, i + 5).reduce((a, b) => a + b, 0) / 5;
          if (avg > maxRollingAvg) maxRollingAvg = avg;
        }
        if (maxRollingAvg > 15) {
          const penalty = { key: 'cpsSpike', label: `CPS burst detected (peak 5-sample avg: ${maxRollingAvg.toFixed(1)})`, deduction: 10 };
          result.penalties.push(penalty);
          result.score -= penalty.deduction;
        }

        // Check: low variance = bot-like consistency (real humans have jitter)
        const nonZero = cpsValues.filter(v => v > 0);
        if (nonZero.length >= 20) {
          const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
          const variance = nonZero.reduce((a, v) => a + (v - mean) ** 2, 0) / nonZero.length;
          const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
          if (cv < 0.15 && mean > 2) {
            const penalty = { key: 'lowVarianceCps', label: `Suspiciously consistent click rate (CV: ${cv.toFixed(2)})`, deduction: 15 };
            result.penalties.push(penalty);
            result.score -= penalty.deduction;
          }
        }

        // Check: sustained clicking with no breaks (bots don't rest)
        if (cpsValues.length >= 50) {
          const activeRatio = cpsValues.filter(v => v > 2).length / cpsValues.length;
          if (activeRatio > 0.85) {
            const penalty = { key: 'sustainedClicking', label: `${Math.round(activeRatio * 100)}% of samples show sustained clicking`, deduction: 10 };
            result.penalties.push(penalty);
            result.score -= penalty.deduction;
          }
        }

        result.score = Math.max(0, result.score);
        const tierInfo = TRUST_TIERS.find(t => result.score >= t.minScore) || TRUST_TIERS[TRUST_TIERS.length - 1];
        result.tier = tierInfo.tier;
        result.tierLabel = tierInfo.label;
        result.tierIcon = tierInfo.icon;
        result.tierColor = tierInfo.color;
      }
    } catch (e) {
      // Non-blocking — fall back to sync-only trust
    }
  }

  return result;
};

module.exports = {
  TRUST_TIERS,
  computeTrustFactor,
  computeTrustTier,
  computeTrustFactorAsync,
};

const { z } = require('zod');

const addScoreSchema = z.object({
  body: z.object({
    // Delta is per-2s-sync — well within Number range even at extreme prestige. Bounds widened
    // alongside the SCORE_CAP lift (1e27 → 1e308) so legitimate large-batch sync (offline
    // catch-up) isn't rejected.
    delta: z.number()
      .min(-1e308, 'Delta below minimum value')
      .max(1e308, 'Delta exceeds maximum value'),
    cps: z.number()
      .min(0, 'CPS must be non-negative')
      .optional(),
    clickDamage: z.number()
      .int()
      .min(0, 'Click damage must be non-negative')
      .optional(),
    bossId: z.string().optional(),
    source: z.string().optional()
  }).passthrough()
});

const getLeaderboardSchema = z.object({
  query: z.object({
    limit: z.string().optional().transform(val => val ? parseInt(val) : 50),
    offset: z.string().optional().transform(val => val ? parseInt(val) : 0),
    period: z.string().optional()
  })
});

// Game state schema — kept in sync with `buildSavePayload` in
// sad-cats-dot-org/src/pages/Game.jsx. When the frontend payload grows, expand this
// schema in the same PR. Issue #2 (audit) documents the historical drift.
//
// Settings / musicSettings are kept open (z.record(z.any())) because they're a
// pass-through JSON bag the frontend owns end-to-end.
const gameStateSchema = z.object({
  body: z.object({
    gameState: z.object({
      // --- Core economy
      upgrades: z.record(z.string(), z.number().int().min(0)).optional().default({}),
      prestigeLevel: z.number().int().min(0).optional().default(0),
      prestigeMultiplier: z.number().min(1).optional().default(1),
      // lifetimeEarnings / cycleEarnings: serialized as Number on the wire (lossy
      // above 9e15 — acceptable trade for a simple contract; the canonical Decimal
      // string lives in localStorage and the score column).
      lifetimeEarnings: z.number().min(0).optional().default(0),
      cycleEarnings: z.number().min(0).optional().default(0),
      cosmicPrestigeBonus: z.number().min(0).optional().default(0),
      unlockedAchievements: z.array(z.string()).optional().default([]),
      skillTree: z.record(z.string(), z.union([z.boolean(), z.string(), z.null(), z.number()])).optional().default({}),

      // --- Daily challenges / micro-quests
      dailyChallenges: z.object({
        date: z.string().nullable().optional().default(null),
        clicks: z.number().int().min(0).optional().default(0),
        earned: z.number().min(0).optional().default(0),
        maxCombo: z.number().int().min(0).optional().default(0),
        upgradesBought: z.number().int().min(0).optional().default(0),
        playSeconds: z.number().int().min(0).optional().default(0),
        claimed: z.array(z.boolean()).max(3).optional().default([false, false, false])
      }).optional().default({ date: null, clicks: 0, earned: 0, maxCombo: 0, upgradesBought: 0, playSeconds: 0, claimed: [false, false, false] }),
      // Backward compat: accept the legacy singular format from pre-2026 clients.
      dailyChallenge: z.object({
        date: z.string().nullable().optional().default(null),
        clicks: z.number().int().min(0).optional().default(0),
        claimed: z.boolean().optional().default(false)
      }).optional(),
      microQuest: z.any().nullable().optional().default(null),

      // --- Prestige / ascension
      starShards: z.number().int().min(0).optional().default(0),
      ascensionLevel: z.number().int().min(0).optional().default(0),
      ascensionMultiplier: z.number().min(1).optional().default(1),
      cosmicBuff: z.any().nullable().optional().default(null),

      // --- Activity counters
      totalClicks: z.number().int().min(0).optional().default(0),
      totalClickTime: z.number().int().min(0).optional().default(0),
      totalPlayTime: z.number().min(0).optional().default(0),
      lastPullTime: z.number().nullable().optional().default(null),
      totalMicroQuestsCompleted: z.number().int().min(0).optional().default(0),
      bossesDefeated: z.number().int().min(0).optional().default(0),
      allTimeMaxCombo: z.number().int().min(0).optional().default(0),
      totalDailyChallengesClaimed: z.number().int().min(0).optional().default(0),
      cosmicPullCount: z.number().int().min(0).optional().default(0),

      // --- Admin / sync metadata
      // Server is authoritative for _adminVersion — frontend echoes it back so we
      // can detect stale-client overwrites (see saveFullState handler).
      _adminVersion: z.number().int().min(0).optional().default(0),
      // Client's snapshot of its own balance at save time; informational only,
      // the canonical balance lives in the `score` column.
      _savedBalance: z.number().min(0).optional().default(0),

      // --- Settings (pass-through JSON bags — frontend owns the shape)
      settings: z.record(z.any()).optional().default({}),
      musicSettings: z.record(z.any()).optional().default({})
    }).strict()
  })
});

module.exports = {
  addScoreSchema,
  getLeaderboardSchema,
  gameStateSchema
};

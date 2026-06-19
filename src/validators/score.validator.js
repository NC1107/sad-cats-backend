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
// IMPORTANT: this object is `.strip()`, NOT `.strict()`. saveFullState does a full
// overwrite of game_state, so a validation error here means the ENTIRE save is
// rejected and every stat (totalClicks, totalPlayTime, …) silently stops persisting
// until the next valid save. `.strict()` made any out-of-sync field from the frontend
// nuke the whole save; `.strip()` validates known fields and silently drops unknown
// ones, so drift degrades gracefully. The contract test in tests/score.validator.test.js
// asserts the live buildSavePayload shape (and the Settings-reset shape) still validate,
// so genuine drift is caught in CI rather than in production saves.
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
      // Derived income stats (deterministic from upgrades+prestige via recalcDerived).
      // Persisted so the anti-cheat soft-cap (computeMaxDelta) has a real earnings
      // ceiling to validate score deltas against. No max — they grow unbounded with
      // prestige (and are lossy-as-Number above 9e15, acceptable for a ceiling).
      catsPerSecond: z.number().min(0).optional().default(0),
      clickPower: z.number().min(0).optional().default(1),
      clickMultiplier: z.number().min(0).optional().default(1),
      cpsMultiplier: z.number().min(0).optional().default(1),
      autoClicksPerSecond: z.number().min(0).optional().default(0),
      // lifetimeEarnings / cycleEarnings: serialized as Number on the wire (lossy
      // above 9e15 — acceptable trade for a simple contract; the canonical Decimal
      // string lives in localStorage and the score column).
      lifetimeEarnings: z.number().min(0).optional().default(0),
      cycleEarnings: z.number().min(0).optional().default(0),
      cosmicPrestigeBonus: z.number().min(0).optional().default(0),
      unlockedAchievements: z.array(z.string()).optional().default([]),
      skillTree: z.record(z.string(), z.union([z.boolean(), z.string(), z.null(), z.number()])).optional().default({}),

      // --- Daily challenges / micro-quests
      // Nullable: the Settings "reset progress" flow sends dailyChallenges: null.
      // Without .nullable() that reset 400s and (under the old .strict()) wiped the
      // whole save. The frontend treats a null/absent value as "fresh" on load.
      dailyChallenges: z.object({
        date: z.string().nullable().optional().default(null),
        clicks: z.number().int().min(0).optional().default(0),
        earned: z.number().min(0).optional().default(0),
        maxCombo: z.number().int().min(0).optional().default(0),
        upgradesBought: z.number().int().min(0).optional().default(0),
        playSeconds: z.number().int().min(0).optional().default(0),
        claimed: z.array(z.boolean()).max(3).optional().default([false, false, false])
      }).nullable().optional().default({ date: null, clicks: 0, earned: 0, maxCombo: 0, upgradesBought: 0, playSeconds: 0, claimed: [false, false, false] }),
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

      // --- Settings (pass-through JSON bags — frontend owns the shape)
      settings: z.record(z.any()).optional().default({}),
      musicSettings: z.record(z.any()).optional().default({})
    }).strip()
  })
});

module.exports = {
  addScoreSchema,
  getLeaderboardSchema,
  gameStateSchema
};

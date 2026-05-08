const { z } = require('zod');

const addScoreSchema = z.object({
  body: z.object({
    delta: z.number()
      .int('Delta must be an integer')
      .min(-1e27, 'Delta below minimum value')
      .max(1e27, 'Delta exceeds maximum value'),
    cps: z.number()
      .min(0, 'CPS must be non-negative')
      .optional(),
    clickDamage: z.number()
      .int()
      .min(0, 'Click damage must be non-negative')
      .optional(),
    source: z.string().optional()
  }).passthrough()
});

const getLeaderboardSchema = z.object({
  query: z.object({
    limit: z.string().optional().transform(val => val ? parseInt(val) : 50),
    offset: z.string().optional().transform(val => val ? parseInt(val) : 0)
  })
});

const gameStateSchema = z.object({
  body: z.object({
    gameState: z.object({
      upgrades: z.record(z.string(), z.number().int().min(0)).optional().default({}),
      prestigeLevel: z.number().int().min(0).optional().default(0),
      prestigeMultiplier: z.number().min(1).optional().default(1),
      lifetimeEarnings: z.number().min(0).optional().default(0),
      unlockedAchievements: z.array(z.string()).optional().default([]),
      skillTree: z.record(z.string(), z.union([z.boolean(), z.string(), z.null()])).optional().default({}),
      dailyChallenges: z.object({
        date: z.string().nullable().optional().default(null),
        clicks: z.number().int().min(0).optional().default(0),
        earned: z.number().min(0).optional().default(0),
        maxCombo: z.number().int().min(0).optional().default(0),
        upgradesBought: z.number().int().min(0).optional().default(0),
        playSeconds: z.number().int().min(0).optional().default(0),
        claimed: z.array(z.boolean()).max(3).optional().default([false, false, false])
      }).optional().default({ date: null, clicks: 0, earned: 0, maxCombo: 0, upgradesBought: 0, playSeconds: 0, claimed: [false, false, false] }),
      // Backward compat: accept old singular format too
      dailyChallenge: z.object({
        date: z.string().nullable().optional().default(null),
        clicks: z.number().int().min(0).optional().default(0),
        claimed: z.boolean().optional().default(false)
      }).optional(),
      starShards: z.number().int().min(0).optional().default(0),
      ascensionLevel: z.number().int().min(0).optional().default(0),
      ascensionMultiplier: z.number().min(1).optional().default(1),
      cosmicBuff: z.any().nullable().optional().default(null),
      totalClicks: z.number().int().min(0).optional().default(0),
      totalClickTime: z.number().int().min(0).optional().default(0),
      lastPullTime: z.number().nullable().optional().default(null),
      microQuest: z.any().nullable().optional().default(null)
    })
  })
});

module.exports = {
  addScoreSchema,
  getLeaderboardSchema,
  gameStateSchema
};

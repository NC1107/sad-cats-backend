const { addScoreSchema, gameStateSchema, getLeaderboardSchema } = require('../src/validators/score.validator');

describe('addScoreSchema', () => {
  test('accepts a minimal delta', () => {
    const parsed = addScoreSchema.parse({ body: { delta: 42 } });
    expect(parsed.body.delta).toBe(42);
  });
  test('accepts negative deltas (bot penalties)', () => {
    expect(() => addScoreSchema.parse({ body: { delta: -5 } })).not.toThrow();
  });
  test('rejects non-numeric delta', () => {
    expect(() => addScoreSchema.parse({ body: { delta: 'lots' } })).toThrow();
  });
  test('rejects CPS below zero', () => {
    expect(() => addScoreSchema.parse({ body: { delta: 0, cps: -1 } })).toThrow();
  });
  test('passes through extra fields (passthrough body)', () => {
    const parsed = addScoreSchema.parse({ body: { delta: 1, discordId: 'abc', username: 'u' } });
    expect(parsed.body.discordId).toBe('abc');
    expect(parsed.body.username).toBe('u');
  });
});

describe('gameStateSchema', () => {
  test('fills defaults for an empty object', () => {
    const parsed = gameStateSchema.parse({ body: { gameState: {} } });
    expect(parsed.body.gameState.prestigeLevel).toBe(0);
    expect(parsed.body.gameState.upgrades).toEqual({});
    expect(parsed.body.gameState.dailyChallenges.claimed).toEqual([false, false, false]);
  });

  test('accepts the newly-tracked fields (issue #2)', () => {
    const parsed = gameStateSchema.parse({
      body: {
        gameState: {
          cycleEarnings: 100,
          cosmicPrestigeBonus: 0.5,
          totalPlayTime: 12345,
          totalMicroQuestsCompleted: 7,
          bossesDefeated: 3,
          allTimeMaxCombo: 50,
          totalDailyChallengesClaimed: 9,
          cosmicPullCount: 4,
          _adminVersion: 0,
          settings: { soundVolume: 0.5 },
          musicSettings: { volume: 0.3 },
        }
      }
    });
    expect(parsed.body.gameState.cycleEarnings).toBe(100);
    expect(parsed.body.gameState.totalPlayTime).toBe(12345);
    expect(parsed.body.gameState.settings.soundVolume).toBe(0.5);
    expect(parsed.body.gameState.musicSettings.volume).toBe(0.3);
  });

  // The schema is .strip() (not .strict()): a full-overwrite save must not be
  // rejected wholesale just because the client sent an unknown field — that would
  // silently stop every stat from persisting. Unknown fields are dropped, known
  // fields still validate and survive.
  test('strip mode drops unknown top-level fields instead of rejecting the save', () => {
    const parsed = gameStateSchema.parse({
      body: { gameState: { neverHeardOfIt: 1, totalClicks: 5 } }
    });
    expect(parsed.body.gameState.neverHeardOfIt).toBeUndefined();
    expect(parsed.body.gameState.totalClicks).toBe(5);
  });

  test('rejects negative balances', () => {
    expect(() => gameStateSchema.parse({
      body: { gameState: { lifetimeEarnings: -1 } }
    })).toThrow();
  });

  // Contract test: the exact key set produced by buildSavePayload in
  // sad-cats-dot-org/src/pages/Game.jsx must validate. If the frontend payload
  // grows and this drifts, CI fails here instead of stats silently vanishing in prod.
  test('accepts the full live buildSavePayload shape', () => {
    const payload = {
      upgrades: { autoClicker: 3 },
      prestigeLevel: 2,
      prestigeMultiplier: 1.5,
      lifetimeEarnings: 123456,
      cycleEarnings: 1000,
      cosmicPrestigeBonus: 0,
      unlockedAchievements: ['first_click'],
      skillTree: { purrs_1: true, lastRespec: '2026-01-01' },
      dailyChallenges: { date: '2026-06-18', clicks: 10, earned: 50, maxCombo: 5, upgradesBought: 1, playSeconds: 120, claimed: [true, false, false] },
      totalClicks: 500,
      totalClickTime: 400,
      totalPlayTime: 3600,
      lastPullTime: null,
      cosmicBuff: null,
      starShards: 12,
      ascensionLevel: 1,
      ascensionMultiplier: 2,
      microQuest: null,
      totalMicroQuestsCompleted: 4,
      bossesDefeated: 3,
      allTimeMaxCombo: 42,
      totalDailyChallengesClaimed: 9,
      cosmicPullCount: 2,
      _adminVersion: 0,
      settings: { numberFormat: 'standard' },
      musicSettings: { volume: 0.3 },
    };
    expect(() => gameStateSchema.parse({ body: { gameState: payload } })).not.toThrow();
  });

  // The Settings → "reset progress" flow sends dailyChallenges: null. This must
  // validate (it used to 400 under .strict() + non-nullable, wiping the save).
  test('accepts the Settings reset shape (dailyChallenges: null)', () => {
    const resetState = {
      upgrades: {}, prestigeLevel: 0, prestigeMultiplier: 1,
      lifetimeEarnings: 0, cycleEarnings: 0, cosmicPrestigeBonus: 0,
      unlockedAchievements: [], skillTree: {}, dailyChallenges: null,
      totalClicks: 0, totalClickTime: 0, lastPullTime: null, cosmicBuff: null,
      starShards: 0, ascensionLevel: 0, ascensionMultiplier: 1, microQuest: null,
      totalMicroQuestsCompleted: 0, bossesDefeated: 0, _adminVersion: 0,
    };
    const parsed = gameStateSchema.parse({ body: { gameState: resetState } });
    expect(parsed.body.gameState.dailyChallenges).toBeNull();
  });
});

describe('getLeaderboardSchema', () => {
  test('parses limit + offset as integers from string query', () => {
    const parsed = getLeaderboardSchema.parse({ query: { limit: '25', offset: '50' } });
    expect(parsed.query.limit).toBe(25);
    expect(parsed.query.offset).toBe(50);
  });
  test('defaults limit=50 / offset=0 when omitted', () => {
    const parsed = getLeaderboardSchema.parse({ query: {} });
    expect(parsed.query.limit).toBe(50);
    expect(parsed.query.offset).toBe(0);
  });
});

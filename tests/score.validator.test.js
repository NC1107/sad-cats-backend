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

  test('accepts all 12 newly-tracked fields (issue #2)', () => {
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
          _savedBalance: 1234567,
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

  test('strict mode rejects unknown top-level fields (catches future drift)', () => {
    expect(() => gameStateSchema.parse({
      body: { gameState: { neverHeardOfIt: 1 } }
    })).toThrow();
  });

  test('rejects negative balances', () => {
    expect(() => gameStateSchema.parse({
      body: { gameState: { lifetimeEarnings: -1 } }
    })).toThrow();
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

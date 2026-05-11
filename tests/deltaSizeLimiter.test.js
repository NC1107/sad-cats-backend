// Locks down the budget arithmetic so a future refactor can't accidentally
// move the throttle point. We mock Redis to drive the counter values
// directly — the middleware logic is just "look up counter, compare to budget".

jest.mock('../src/config/redis', () => {
  const counters = new Map();
  return {
    redisClient: {
      incrBy: jest.fn(async (key, amount) => {
        const next = (counters.get(key) || 0) + amount;
        counters.set(key, next);
        return next;
      }),
      expire: jest.fn().mockResolvedValue(1),
      _reset: () => counters.clear(),
      _set: (k, v) => counters.set(k, v),
    },
  };
});
jest.mock('../src/utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/score-validation.service', () => ({
  recordAnomaly: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const { redisClient } = require('../src/config/redis');
const { recordAnomaly } = require('../src/services/score-validation.service');
const { deltaSizeLimiter } = require('../src/middleware/rateLimiter');

const makeReq = (delta, discordId = 'u1') => ({
  user: { data: { discordId } },
  body: { delta },
  ip: '127.0.0.1',
});

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

describe('deltaSizeLimiter', () => {
  beforeEach(() => {
    redisClient._reset();
    redisClient.incrBy.mockClear();
    redisClient.expire.mockClear();
    recordAnomaly.mockClear();
  });

  test('passes through (no cost) when delta <= 0', async () => {
    const req = makeReq(0);
    const res = makeRes();
    const next = jest.fn();
    await deltaSizeLimiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(redisClient.incrBy).not.toHaveBeenCalled();
  });

  test('charges floor(log10(delta) * 1e15) tokens', async () => {
    // log10(1e10) = 10; cost = 10e15. Way under the 1e18 budget.
    await deltaSizeLimiter(makeReq(1e10), makeRes(), jest.fn());
    expect(redisClient.incrBy).toHaveBeenCalledWith('delta_budget:u1', Math.floor(10 * 1e15));
  });

  test('sets the 60s TTL on the first touch only', async () => {
    const next = jest.fn();
    await deltaSizeLimiter(makeReq(1e5), makeRes(), next);
    expect(redisClient.expire).toHaveBeenCalledWith('delta_budget:u1', 60);
    redisClient.expire.mockClear();
    await deltaSizeLimiter(makeReq(1e5), makeRes(), next);
    expect(redisClient.expire).not.toHaveBeenCalled();
  });

  test('rejects with 429 when the budget overflows', async () => {
    // Pre-seed the counter near the 1e18 cap. A 1e10 delta (10e15 tokens) tips over.
    redisClient._set('delta_budget:u1', 9.99e17);
    const res = makeRes();
    const next = jest.fn();
    await deltaSizeLimiter(makeReq(1e10), res, next);
    expect(res.statusCode).toBe(429);
    expect(res.body.success).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });

  test('records a hard anomaly on overflow', async () => {
    redisClient._set('delta_budget:u1', 9.99e17);
    await deltaSizeLimiter(makeReq(1e10), makeRes(), jest.fn());
    expect(recordAnomaly).toHaveBeenCalledWith(
      'u1',
      'delta_budget_exceeded',
      expect.objectContaining({ severity: 'hard' })
    );
  });

  test('fails open when redis throws', async () => {
    redisClient.incrBy.mockRejectedValueOnce(new Error('redis down'));
    const res = makeRes();
    const next = jest.fn();
    await deltaSizeLimiter(makeReq(1e10), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  test('uses discordId from body for bot-auth requests (no req.user)', async () => {
    const req = { user: null, body: { delta: 1e5, discordId: 'bot-user' }, ip: '1.2.3.4' };
    await deltaSizeLimiter(req, makeRes(), jest.fn());
    expect(redisClient.incrBy).toHaveBeenCalledWith('delta_budget:bot-user', expect.any(Number));
  });
});

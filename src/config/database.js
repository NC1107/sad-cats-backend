const { Pool, types } = require('pg');
const logger = require('../utils/logger');

// Return BIGINT (OID 20) and NUMERIC (OID 1700) as strings to avoid precision loss for values > 2^53
types.setTypeParser(20, String);
types.setTypeParser(1700, String);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  logger.info('PostgreSQL client connected');
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
});

// Graceful close — called by server.js shutdown() so requests drain before the
// pool ends. Previously this module registered its own SIGINT/SIGTERM handler
// that ran in parallel with server.js's, severing in-flight queries (issue #8).
const closePool = async () => {
  logger.info('Closing PostgreSQL pool');
  await pool.end();
};

// Run `fn` inside a single transaction on a dedicated pooled connection.
// `fn` receives the client; whatever it returns is the resolved value.
// Any throw rolls back; the connection is always released. Use this for
// multi-step economy flows (catnip spend → item grant) that must be atomic
// so a mid-flight failure can't debit currency without granting the item
// (or grant an item without debiting).
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Transaction rollback failed', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
};

module.exports = pool;
module.exports.closePool = closePool;
module.exports.withTransaction = withTransaction;

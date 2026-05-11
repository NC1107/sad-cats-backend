#!/usr/bin/env node
/**
 * In-house migration runner.
 *
 * Reads `src/db/migrations/*.sql` in lexical order, applies any that haven't
 * been recorded in the `schema_migrations` table, wraps each in a transaction.
 *
 * Idempotent: re-runs are no-ops once everything is applied.
 *
 * Used two ways:
 *   1. CLI: `npm run migrate` (for local dev / one-off backfills).
 *   2. Import: `require('./scripts/migrate').runMigrations()` — called from
 *      `server.js` startup so production deploys self-migrate. Watchtower
 *      pulls a new image, container restarts, this runs before listen.
 *
 * Notes:
 *   - The `002_*` slot is intentionally absent (renamed away early in
 *     development). The runner doesn't care about gaps; ordering is purely
 *     lexical on filename.
 *   - Migrations that touch live data should be idempotent at the SQL level
 *     (CREATE TABLE IF NOT EXISTS, etc.) since the runner has no rollback
 *     concept. For multi-statement migrations, the wrapping transaction
 *     gives us atomicity within a single file.
 *   - When called from server.js we get a logger; the CLI path uses stdout
 *     directly so it shows up in `docker exec` shells without log filtering.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

// SQLSTATE codes that indicate "this migration's effects are already in the
// database." This system was retrofitted onto a DB that had its migrations
// applied by hand, so the first auto-run sees `schema_migrations` empty and
// would try to re-apply every file — many of which have raw `CREATE TABLE`
// (not `IF NOT EXISTS`). Treat these as already-applied: log a warning,
// record the file in schema_migrations, and continue. Future runs skip it.
//
// Once every migration file has been recorded once, this branch never fires
// again for legitimate operation. New migrations added going forward should
// still be written defensively (`CREATE TABLE IF NOT EXISTS`, etc.) so they
// remain re-runnable.
const ALREADY_APPLIED_CODES = new Set([
  '42P07', // duplicate_table
  '42701', // duplicate_column
  '42P06', // duplicate_schema
  '42710', // duplicate_object (functions, indexes, etc.)
  '23505', // unique_violation (seed-data INSERT colliding with existing rows)
]);

/**
 * Run any pending migrations against DATABASE_URL.
 *
 * @param {object} [opts]
 * @param {object} [opts.logger]  optional Winston-shaped logger; falls back to
 *   stdout/stderr writes for the CLI path. `.info`, `.warn`, `.error` are used.
 * @returns {Promise<{ applied: string[], pending: number, total: number }>}
 */
async function runMigrations({ logger } = {}) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const log = logger || {
    info:  (msg) => process.stdout.write(`${msg}\n`),
    warn:  (msg) => process.stderr.write(`${msg}\n`),
    error: (msg) => process.stderr.write(`${msg}\n`),
  };

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const appliedNow = [];

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const alreadyApplied = new Set(
      (await pool.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename)
    );
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    const pending = files.filter(f => !alreadyApplied.has(f));

    if (pending.length === 0) {
      log.info(`Migrations: ${files.length} already applied, 0 pending`);
      return { applied: [], pending: 0, total: files.length };
    }

    log.info(`Migrations: applying ${pending.length} pending`);

    for (const filename of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        appliedNow.push(filename);
        log.info(`  ✓ ${filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        // "Already exists" errors mean a pre-tracking-era migration is being
        // re-applied to a DB that already has it. Record as applied and move
        // on — don't abort the whole run, which would block newer migrations
        // (like 022_anti_cheat.sql) from ever reaching their turn.
        if (ALREADY_APPLIED_CODES.has(err.code)) {
          log.warn(`  ~ ${filename} appears already applied (SQLSTATE ${err.code}: ${err.message}); recording as applied and continuing`);
          try {
            await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [filename]);
            appliedNow.push(filename);
          } catch (recordErr) {
            log.error(`Failed to record ${filename} as applied: ${recordErr.message}`);
          }
          continue;
        }
        log.error(`  ✗ ${filename}: ${err.message}`);
        throw err;
      } finally {
        client.release();
      }
    }

    log.info(`Migrations: ${appliedNow.length} applied`);
    return { applied: appliedNow, pending: pending.length, total: files.length };
  } finally {
    await pool.end();
  }
}

module.exports = { runMigrations };

// CLI entrypoint. Only fires when invoked directly (`node src/scripts/migrate.js`
// or `npm run migrate`), not when require'd by server.js.
if (require.main === module) {
  require('dotenv').config();
  runMigrations()
    .then(() => process.exit(0))
    .catch(err => {
      process.stderr.write(`Migration failed: ${err.message}\n`);
      process.exit(1);
    });
}

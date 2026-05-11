#!/usr/bin/env node
/**
 * In-house migration runner.
 *
 * Reads `src/db/migrations/*.sql` in lexical order, applies any that haven't
 * been recorded in the `schema_migrations` table, wraps each in a transaction.
 *
 * Idempotent: re-runs are no-ops once everything is applied.
 *
 * Usage:
 *   npm run migrate
 *
 * Notes:
 *   - The `002_*` slot is intentionally absent (renamed away early in
 *     development). The runner doesn't care about gaps; ordering is purely
 *     lexical on filename.
 *   - `DATABASE_URL` must be set, otherwise `config/env.js` would have
 *     refused boot — but this script doesn't go through that path because
 *     it runs standalone, so we re-check here.
 *   - Migrations that touch live data should be idempotent at the SQL level
 *     (CREATE TABLE IF NOT EXISTS, etc.) since the runner has no rollback
 *     concept. For multi-statement migrations, the wrapping transaction
 *     gives us atomicity within a single file.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is required.\n');
  process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Bootstrap the tracking table (also idempotent).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const applied = new Set(
      (await pool.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename)
    );

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let pending = files.filter(f => !applied.has(f));
    if (pending.length === 0) {
      process.stdout.write(`No pending migrations. ${files.length} applied.\n`);
      return;
    }

    process.stdout.write(`Applying ${pending.length} migration(s)...\n`);

    for (const filename of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename]
        );
        await client.query('COMMIT');
        process.stdout.write(`  ✓ ${filename}\n`);
      } catch (err) {
        await client.query('ROLLBACK');
        process.stderr.write(`  ✗ ${filename}: ${err.message}\n`);
        throw err;
      } finally {
        client.release();
      }
    }

    process.stdout.write(`Done. ${pending.length} migration(s) applied.\n`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  process.stderr.write(`Migration failed: ${err.message}\n`);
  process.exit(1);
});

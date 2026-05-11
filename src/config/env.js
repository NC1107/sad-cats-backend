// Boot-time env validation. Crashes loudly on missing required vars instead of
// 500-ing the first request that touches them (issue #17).
//
// Required vars are listed below with their consumers — keep this list in sync
// when adding new ones. Optional vars get sensible defaults at consumer sites
// (don't add defaults here for genuinely optional things; the goal is to fail
// fast on missing *required* config, not to centralize defaults).

const { z } = require('zod');

const schema = z.object({
  // --- Networking
  PORT: z.string().regex(/^\d+$/).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
  CORS_ORIGIN: z.string().url().optional(),

  // --- Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgres://user:pass@host:port/db)'),

  // --- Redis
  REDIS_URL: z.string().min(1, 'REDIS_URL is required (redis://host:port or rediss://...)'),

  // --- Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().optional(),

  // --- Discord OAuth
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required'),
  DISCORD_CALLBACK_URL: z.string().url('DISCORD_CALLBACK_URL must be a full URL'),
  DISCORD_GUILD_ID: z.string().optional(),

  // --- Bot integration
  BOT_API_SECRET: z.string().min(16, 'BOT_API_SECRET must be at least 16 chars'),

  // --- Admin allowlist (comma-separated Discord IDs)
  ADMIN_DISCORD_IDS: z.string().min(1, 'ADMIN_DISCORD_IDS is required (comma-separated Discord IDs)'),

  // --- Frontend redirect targets
  FRONTEND_URL: z.string().url().optional(),

  // --- Optional: Discord archive sqlite path
  ARCHIVE_DB_PATH: z.string().optional(),
});

function validateEnv() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join('.') || '(unknown)'}: ${i.message}`)
      .join('\n');
    // Use stderr directly — logger may not be available before this runs and we
    // want this to escape any log filter / aggregator.
    process.stderr.write(`\nEnv validation failed:\n${issues}\n\nFix .env and restart.\n\n`);
    process.exit(1);
  }
  return result.data;
}

module.exports = { validateEnv };

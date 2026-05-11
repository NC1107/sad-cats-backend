# sad-cats-backend

Express.js API for [sad-cats.org](https://sad-cats.org) — the Sad Cat Worshipers Discord community platform.
Powers Discord OAuth, the idle clicker game, the daily community boss battle, and the live leaderboard.

Companion projects:

- Frontend: [NC1107/sad-cats-dot-org](https://github.com/NC1107/sad-cats-dot-org) (React + Vite, deployed on Cloudflare Pages)
- Discord bot: lives on the same host, runs in a `screen` session

## Stack

- Node.js 20 + Express 4
- PostgreSQL 15 (game state, scores, bosses)
- Redis 7 (JWT blacklist, rate limits, cache)
- Socket.IO 4 (live leaderboard, boss broadcasts)
- better-sqlite3 (read-only Discord archive)

## Local development

```bash
cp .env.example .env   # fill in everything listed below
npm install
npm run dev
```

Requires a running Postgres and Redis. The simplest way to get them is to bring up the full stack from the parent compose file in the deployment repo.

### Required env vars

Validated at boot by `src/config/env.js`. Missing or short values crash with a field-level error before the server starts:

| Var | Notes |
|-----|-------|
| `DATABASE_URL` | `postgres://user:pass@host:port/db` |
| `REDIS_URL` | `redis://host:port` or `rediss://...` |
| `JWT_SECRET` | ≥ 32 chars |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | from Discord developer portal |
| `DISCORD_CALLBACK_URL` | full URL, must match Discord OAuth redirect |
| `BOT_API_SECRET` | ≥ 16 chars, shared with the Discord bot for `/api/scores/*` bot-auth |
| `ADMIN_DISCORD_IDS` | comma-separated Discord user IDs that get admin access |

Optional: `PORT`, `NODE_ENV`, `CORS_ORIGIN`, `JWT_EXPIRES_IN`, `JWT_ALGORITHM`, `DISCORD_GUILD_ID`, `FRONTEND_URL`, `ARCHIVE_DB_PATH`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`.

### Migrations

There is no automated runner yet (tracked as issue #18). Apply SQL files in `src/db/migrations/` to your local Postgres in order (`001_*.sql`, then `003_*.sql`, …). The `002_*` slot is intentionally skipped.

## Production deployment

Pushes to `main` trigger [`.github/workflows/build-and-push.yml`](.github/workflows/build-and-push.yml), which builds a Docker image and publishes it to:

```
ghcr.io/nc1107/sad-cats-backend:latest
ghcr.io/nc1107/sad-cats-backend:sha-<commit>
```

The production server runs Watchtower against the `:latest` tag, so a successful CI build redeploys automatically.

## Manual image build

```bash
docker build -t sad-cats-backend:dev .
docker run --rm -p 3001:3001 --env-file .env sad-cats-backend:dev
```

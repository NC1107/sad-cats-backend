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
cp .env.example .env   # fill in Discord OAuth + JWT + DB creds
npm install
npm run dev
```

Requires a running Postgres and Redis. The simplest way to get them is to bring up the full stack from the parent compose file in the deployment repo.

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

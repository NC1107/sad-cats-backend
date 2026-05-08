# Server-side anti-cheat plan (H3)

Status: **planned, not started**. Tracked in the frontend repo as [TECHNICAL_DEBT.md](../sad-cats-dot-org/TECHNICAL_DEBT.md) item **H3** and GitHub issue [#1 in sad-cats-dot-org](https://github.com/NC1107/sad-cats-dot-org/issues/1).

## Problem

`POST /scores/add` accepts an arbitrary `delta` from the client. The server already does soft-cap clamping with winston warnings (`scores.controller.js:72–86`), but a player with devtools can fire `apiClient.addScore(1e27)` and either max out instantly or come close. The state-save endpoint (`PUT /scores/state`) trusts the client even harder — it accepts any `gameState` with no monotonicity guard, so a cheater can set `prestigeLevel: 100` directly.

## Decisions already made

- **Rollout**: clamp + log on day one (matches current behavior, no false-positive rejections). After one week of clean signal in the new audit table, flip to reject.
- **Validation depth**: cached `game_state` values + monotonicity guards. **Not** mirroring frontend formulas to backend — deferred unless audit data shows cached-value cheating.
- **Pattern**: mirror `services/trust.service.js` (read-only signal-based service).

## Phase 1 — Foundation (~3 days)

Anomaly tracking active in production, zero behavioral change for legitimate clients.

### 1. Migration: `src/db/migrations/022_anti_cheat.sql`

```sql
ALTER TABLE scores ADD COLUMN last_sync_at TIMESTAMPTZ;
UPDATE scores SET last_sync_at = updated_at;
ALTER TABLE scores ALTER COLUMN last_sync_at SET DEFAULT NOW();
ALTER TABLE scores ALTER COLUMN last_sync_at SET NOT NULL;

CREATE TABLE score_anomalies (
    id           BIGSERIAL PRIMARY KEY,
    discord_id   VARCHAR(255) NOT NULL,
    kind         VARCHAR(64) NOT NULL,    -- 'delta_clamped', 'monotonicity_violation', etc.
    delta        NUMERIC,
    max_delta    NUMERIC,
    elapsed_sec  INTEGER,
    payload      JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX score_anomalies_discord_idx ON score_anomalies(discord_id, created_at DESC);
```

### 2. New service: `src/services/score-validation.service.js`

Mirror `services/trust.service.js` shape (read-only, signal-based, no DB writes from compute paths).

- `computeMaxDelta(gs, elapsedSec)` — keep the formula already in `scores.controller.js:72–86` (cached `catsPerSecond`, `cpsMultiplier`, `prestigeMultiplier`, `ascensionMultiplier`, `clickPower`, `clickMultiplier`, 10× buff headroom).
- `validateMonotonicity(prevState, nextState)` — guards:
  - `prestigeLevel` may grow by ≤ 1 per save
  - `ascensionLevel` may grow by ≤ 1 per save (and only when prestige reset accompanies it)
  - Each `upgrades[id]` may only grow if the cost was affordable from previous balance + accrued income window
  - `lifetimeEarnings` and `cycleEarnings` are non-decreasing, except on prestige/ascension
- `recordAnomaly(discordId, kind, payload)` — INSERT into `score_anomalies` + `logger.warn` (winston pattern from `utils/logger.js`).

### 3. Controller updates: `src/controllers/scores.controller.js`

- **`/scores/add`** (lines 26–160): keep current clamp behavior. When clamp kicks in, also call `recordAnomaly(discordId, 'delta_clamped', { delta, maxDelta, elapsedSec })`. Update `last_sync_at` on success.
- **`/scores/state`** (PUT, `saveFullState` at lines 249–304): add `validateMonotonicity(currentRow.game_state, body.gameState)` before the UPDATE. On violation, call `recordAnomaly(discordId, 'monotonicity_violation', { violations })`. **Do not reject yet** — Phase 3 flips this to a 4xx.
- Both: include `last_sync_at` in the SET clause.

### 4. Rate limiter: `src/middleware/rateLimiter.js`

Add `deltaSizeLimiter` — token-bucket proportional to delta magnitude, not request count. Stops "carpet bomb 100 valid-looking deltas/second."

```js
// rough sketch
const budget = 1e15;            // tokens per minute
const cost = Math.log10(Math.max(1, delta));   // each request burns log10(delta) tokens
```

### 5. Admin readout: `src/controllers/admin.controller.js`

`GET /admin/anomalies?discord_id=...&since=...` — returns recent rows from `score_anomalies` for soak review.

### Verification

- `curl` with bot auth: `POST /scores/add {delta: 1e25}` → row appears in `score_anomalies` with `kind=delta_clamped`. `score` column unchanged or clamped per current behavior.
- `curl`: `PUT /scores/state` with `prestigeLevel = previous + 5` → row with `kind=monotonicity_violation`. Row is still written (not rejected yet).
- 24 h of legitimate sync traffic on staging → 0 monotonicity_violation rows.
- `GET /admin/anomalies` returns the inserted rows.

## Phase 2 — Soak (1 week)

Watch the `score_anomalies` table. Categorize rows:
- **Clearly cheating**: delta > 100× soft-cap, prestige skips, upgrades-bought-without-funds.
- **Edge cases worth tolerating**: 1–10× soft-cap (likely buff/skill stacking), single-step monotonicity skips on prestige/ascension boundaries.

Use this signal to set Phase 3 thresholds. Gate: < 0.1% of legitimate users hit any anomaly.

## Phase 3 — Enforcement turn-on (~1 day)

After clean soak signal:

1. Flip `/scores/add` and `/scores/state` from clamp-with-log to **reject-with-422** for clearly illegitimate patterns:
   - `delta > 100 * maxDelta` → 422
   - Any monotonicity violation → 422
2. Keep clamp-with-log for soft violations.
3. **Frontend handler** (in `sad-cats-dot-org`): `apiClient.addScore` and `apiClient.saveGameState` need to handle 422 gracefully — show a toast, force a full state reload from server. Current code likely crashes or silently fails.
4. Replay a week of legitimate-traffic anomaly rows against the strict rules — zero rejections of legitimate patterns is the gate.

## Files touched

- `src/db/migrations/022_anti_cheat.sql` — **new**
- `src/services/score-validation.service.js` — **new**
- `src/controllers/scores.controller.js` — extend
- `src/middleware/rateLimiter.js` — extend
- `src/controllers/admin.controller.js` — add readout

Frontend (separate repo, Phase 3 only):
- `src/lib/api.js` — handle 422
- `src/pages/Game.jsx` — toast + reload-from-server on 422

## Out of scope

- Server-side formula mirror (recompute CPS/click-power from raw upgrade levels) — deferred unless audit data shows cached-value cheating.
- WebSocket boss-damage validation — separate area.
- Backfilling `score_anomalies` from existing trust-service warnings — green-field table.

## Open questions

- **Wire format for `delta`**: planned to stay Number on `/scores/add` (2-second batches stay under MAX_SAFE_INTEGER). If a long offline-catchup batch produces `delta > 9e15`, escalate to string at the API boundary.
- **`updated_at` reliability**: Phase 1 backfills `last_sync_at = updated_at`. Confirm `updated_at` is reliably maintained on every score-mutation path.
- **Staging environment**: Phase 1 verification step needs a staging DB. If there isn't one, run Phase 1 against prod with read-only checks for the first 24 h before enabling writes to `score_anomalies`.

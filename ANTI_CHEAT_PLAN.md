# Server-side anti-cheat plan (H3)

**Status:** planned, not started. Tracked as frontend issue [#1](https://github.com/NC1107/sad-cats-dot-org/issues/1).
**Last refreshed:** 2026-05-11 (after the security/cleanup batch landed — schema, validators, OAuth state, NUMERIC, env validation, sync-lock, etc. all in place).

---

## Threat model

`POST /scores/add` and `PUT /scores/state` are the two write surfaces.

| Attack | Today's defense | Gap |
|---|---|---|
| **Delta inflation** (`addScore(1e25)`) | Soft-cap clamp at 10× theoretical max earnings (`scores.controller.js:75-94`), Winston warn | Clamp logs but doesn't persist for review; no rate limit on delta *size*, only request count |
| **Autoclicker / hold-Enter** (~30 cps) | Hard 400 reject if `cps > 17` (line 31); trust-service penalties for sustained CPS bursts, low variance, no rest; frontend now also rejects Enter-key activations at the button (commit 5ba497e) | None — this layer is in good shape |
| **Game state forgery** (`PUT /scores/state {prestigeLevel: 100}`) | `_adminVersion` guard prevents replay of admin-bumped saves; `gameStateSchema.strict()` blocks unknown fields | **No monotonicity guard.** A client can still send `prestigeLevel: previous + 5` and the server writes it. |
| **Replay / multi-tab** | Per-user 2s Redis sync-lock at `addToScore`; 429 on contention | None — this layer is in good shape |
| **Score column tamper** (admin endpoint abuse) | NUMERIC + LEAST/GREATEST clamp into `[0, SCORE_CAP]`; admin allowlist | None |

The remaining real gap is **persistent anomaly tracking + monotonicity guards on the state-save path.** That's what Phase 1 ships.

---

## Decisions already made

- **Rollout:** clamp + log on day one (matches current behavior, zero false positives). After one week of clean signal in the new audit table, flip to reject.
- **Validation depth:** cached `game_state` values + monotonicity guards. **Not** mirroring frontend formulas to backend. Mirroring is deferred unless audit data shows cached-value cheating.
- **Pattern:** mirror `services/trust.service.js` (read-only signal-based service, no DB writes from compute paths). The new anomaly records *feed* trust-service penalties, not replace them.
- **No false-positive cost:** every gate must be tunable from data, not guessed.

---

## Phase 1 — Foundation (~3 days)

Anomaly tracking active in production. **Zero behavioral change** for legitimate clients (clamp + log preserved; new tables get rows but no rejections happen yet).

### 1. Migration: `src/db/migrations/022_anti_cheat.sql`

```sql
-- last_sync_at gives us a server-controlled timestamp for elapsed-time calculations.
-- The current code reads gs.lastCalculated (client-controlled), which is forgeable.
ALTER TABLE scores ADD COLUMN last_sync_at TIMESTAMPTZ;
UPDATE scores SET last_sync_at = updated_at;
ALTER TABLE scores ALTER COLUMN last_sync_at SET DEFAULT NOW();
ALTER TABLE scores ALTER COLUMN last_sync_at SET NOT NULL;

CREATE TABLE score_anomalies (
    id           BIGSERIAL PRIMARY KEY,
    discord_id   VARCHAR(255) NOT NULL,
    kind         VARCHAR(64) NOT NULL,   -- e.g. 'delta_clamped', 'monotonicity_prestige', 'cps_rejected'
    delta        NUMERIC,                -- the offending delta (if applicable)
    max_delta    NUMERIC,                -- the computed ceiling
    elapsed_sec  INTEGER,                -- time window the delta was checked against
    severity     VARCHAR(16) NOT NULL DEFAULT 'soft',  -- 'soft' | 'hard' (Phase 3 distinguishes)
    payload      JSONB,                  -- arbitrary kind-specific context
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX score_anomalies_discord_idx ON score_anomalies(discord_id, created_at DESC);
CREATE INDEX score_anomalies_kind_idx ON score_anomalies(kind, created_at DESC);
```

Run via `npm run migrate` (already scaffolded in commit 5540b65).

### 2. New service: `src/services/score-validation.service.js`

Mirrors the trust-service shape (read-only signal compute + a single record fn).

```js
// computeMaxDelta — already implemented inline in scores.controller.js:75-94. Extract.
// validateMonotonicity — new. See rules below.
// recordAnomaly — INSERT into score_anomalies + logger.warn.

module.exports = { computeMaxDelta, validateMonotonicity, recordAnomaly }
```

**Monotonicity rules** (`validateMonotonicity(prevState, nextState)` returns `{ violations: [] }`):

| Field | Allowed delta | Notes |
|---|---|---|
| `prestigeLevel` | `+1` per save, OR equal | A prestige reset bumps it once; multi-step jumps are forgery. |
| `ascensionLevel` | `+1` per save, AND only when `prestigeLevel` reset to 0 | Ascension always resets prestige. |
| `upgrades[id]` | `+N` where `N <= floor((prevBalance + accruedIncome) / upgradeCost)` | Tracks affordable purchases since last save. Generous: 10× headroom. |
| `lifetimeEarnings` / `cycleEarnings` | non-decreasing, except `cycleEarnings` may reset to 0 on prestige | The big monotonicity invariant. |
| `bossesDefeated` | non-decreasing, `+N` ≤ active bosses since last save | Bound by the actual boss table — server-knowable. |
| `starShards` | `+N` allowed if `(newPrestige - oldPrestige) * getShardsPerPrestige` covers it | Earn rate is deterministic. |
| any | hard ceiling: `prestigeLevel < 10000`, `ascensionLevel < 1000` | Backstop for any rule that escapes. |

Each violation becomes one `score_anomalies` row with `kind = 'monotonicity_<field>'`.

### 3. Controller updates: `src/controllers/scores.controller.js`

**`addToScore` (lines 26–160):**
- Keep current clamp behavior (clamp + log, no reject).
- When clamp kicks in, call `recordAnomaly(discordId, 'delta_clamped', { delta, maxDelta, elapsedSec, severity: 'soft' })`.
- When `cps > 17`, call `recordAnomaly(discordId, 'cps_rejected', { cps, severity: 'hard' })` (we already reject, just want it in the table).
- Use `last_sync_at` (server-set) instead of `gs.lastCalculated` (client-set) as the elapsed-time anchor. UPDATE `last_sync_at = NOW()` on every successful score change.

**`saveFullState` (lines 251–322):**
- Add `validateMonotonicity(currentRow.game_state, body.gameState)` before the UPDATE.
- On violation, call `recordAnomaly` for each violation kind. **Do not reject yet** — Phase 3 flips this to a 422.
- Keep the existing `_adminVersion` guard (issue #4 fix) — that runs first.

### 4. Rate limiter: `src/middleware/rateLimiter.js`

Add `deltaSizeLimiter` — token-bucket proportional to delta magnitude, not request count. Stops a "carpet bomb 100 valid-looking deltas/second" attack that the per-request limiter doesn't catch.

```js
// rough sketch — refine numbers from Phase 2 soak data
const BUDGET = 1e18;                              // tokens per minute per user
const cost = (delta) => Math.log10(Math.max(1, delta)) * 1e15;
// 1e25 delta = ~25e15 tokens, 1e18 budget allows ~40 such requests/min
```

Wire onto `/scores/add` after `scoreUpdateLimiter`.

### 5. Verification gates for Phase 1

- `curl` with bot auth: `POST /scores/add {delta: 1e25}` → `score_anomalies` row with `kind=delta_clamped`. Score column unchanged or clamped per current behavior.
- `curl`: `PUT /scores/state` with `prestigeLevel = previous + 5` → row with `kind=monotonicity_prestigeLevel`. Save is still applied (not rejected yet).
- 24 h of legitimate sync traffic on prod → 0 `monotonicity_*` rows (this is the data-driven sanity check before Phase 3).
- New jest tests in `tests/score-validation.test.js`: `computeMaxDelta` boundaries, every monotonicity rule.

---

## Phase 2 — Soak (1 week)

Watch the `score_anomalies` table. Categorize rows:

- **Clearly cheating:** delta > 100× soft-cap, prestige skips ≥ 2, upgrades bought without affordable funds, sustained CPS history matching trust-service penalties.
- **Edge cases worth tolerating:** 1–10× soft-cap (likely buff/skill stacking), single-step monotonicity skips on prestige boundaries, low-variance CPS for short bursts.

Build a simple admin readout: `GET /api/admin/anomalies?discord_id=...&kind=...&since=...` returning recent rows. Display in the admin page under each user.

**Gate to Phase 3:** < 0.1% of legitimate users hit any `severity: 'hard'` anomaly during the soak.

---

## Phase 3 — Enforcement turn-on (~1 day)

After clean soak signal, flip from clamp-with-log to **reject-with-422** for clearly illegitimate patterns:

1. `delta > 100 * maxDelta` → 422 `{ error: 'delta_rejected', refreshRequired: true }`
2. Any `severity: 'hard'` monotonicity violation → 422 same shape
3. Keep clamp-with-log for soft violations.

**Frontend coordination** (separate commit in `sad-cats-dot-org`):
- `apiClient.addScore` and `apiClient.saveGameState` need to handle 422 gracefully — show a toast, force a full state reload from server. Current code likely crashes or silently fails on unexpected 4xx shapes.
- The `useScoreSync` and `usePersistence` hooks already have an error path; just need to special-case `error.status === 422 && error.refreshRequired` to trigger the reconcile flow.

**Validation gate:** replay a week of legitimate-traffic anomaly rows against the strict rules — zero rejections of legitimate patterns is the gate before turning the flag on for everyone.

---

## What's already in place (no new work needed)

- ✅ Frontend Enter-key activation blocked (commit 5ba497e); `e.detail === 0` filter on click handlers.
- ✅ Backend `cps > 17` hard reject.
- ✅ Redis CPS history with trust-service penalty rules (sustained CPS, low variance, no rest).
- ✅ Soft-cap maxDelta clamp.
- ✅ Per-user 2s Redis sync-lock against concurrent `addToScore`.
- ✅ `_adminVersion` race fix (commit 9b54817) — atomic UPDATE WHERE clause.
- ✅ `gameStateSchema.strict()` — unknown fields rejected (commit f5f4faa).
- ✅ NUMERIC across all score reads/writes (no BIGINT truncation).
- ✅ OAuth state CSRF (commit 5540b65) — login flow can't be hijacked.
- ✅ Boot-time env validation — missing `JWT_SECRET` etc. crashes fast.

---

## Files touched (Phase 1)

- `src/db/migrations/022_anti_cheat.sql` — **new**
- `src/services/score-validation.service.js` — **new**
- `src/controllers/scores.controller.js` — extend (both handlers)
- `src/middleware/rateLimiter.js` — extend (add `deltaSizeLimiter`)
- `tests/score-validation.test.js` — **new** (unit tests for the monotonicity rules)
- `src/controllers/admin.controller.js` — **Phase 2** only (`/admin/anomalies` readout)

---

## Out of scope (deferred)

- **Server-side formula mirror** — recompute CPS/click-power from raw upgrade levels. Defer unless audit data shows cached-value cheating.
- **WebSocket boss-damage validation** — separate surface; the boss model already has a `damage_dealt` per-row check.
- **Backfilling `score_anomalies` from existing logger.warn lines** — green-field table.

---

## Open questions

- **Wire format for `delta`:** stays Number on `/scores/add` (2-second batches stay under MAX_SAFE_INTEGER). If long offline-catchup batches produce `delta > 9e15`, escalate to string at the API boundary.
- **`updated_at` reliability:** Phase 1 backfills `last_sync_at = updated_at`. Confirm `updated_at` is reliably maintained on every score-mutation path (search for missing `updated_at = NOW()` in models).
- **Staging environment:** if none exists, run Phase 1 against prod with read-only sanity checks for the first 24 h before enabling INSERTs to `score_anomalies`.
- **Trust-service integration:** should new anomaly rows automatically deduct from the trust score, or stay independent? Recommendation: keep independent for the first month, then integrate based on soak data.

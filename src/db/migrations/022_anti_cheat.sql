-- Migration: anti-cheat foundation (issue #1, Phase 1).
--
-- Two pieces:
--
-- 1. `scores.last_sync_at` — server-set timestamp of the last successful score
--    mutation. Used as the elapsed-time anchor for the soft-cap maxDelta
--    calculation in scores.controller.js. Previously that calculation read
--    gs.lastCalculated from the persisted JSONB, which is client-set and
--    therefore forgeable — a cheater could write lastCalculated:0 then send
--    a giant delta with a huge elapsed window.
--
-- 2. `score_anomalies` — append-only audit table. Phase 1 only WRITES to it
--    (clamp/reject events get a row); Phase 2 soak-watches it to tune the
--    Phase 3 thresholds. severity='soft' means clamped-with-warning (no
--    behavior change); severity='hard' means rejected at the API layer.

ALTER TABLE scores ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
UPDATE scores SET last_sync_at = updated_at WHERE last_sync_at IS NULL;
ALTER TABLE scores ALTER COLUMN last_sync_at SET DEFAULT NOW();
ALTER TABLE scores ALTER COLUMN last_sync_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS score_anomalies (
    id           BIGSERIAL PRIMARY KEY,
    discord_id   VARCHAR(255) NOT NULL,
    kind         VARCHAR(64)  NOT NULL,   -- e.g. 'delta_clamped', 'monotonicity_prestigeLevel', 'cps_rejected'
    delta        NUMERIC,                 -- the offending delta (if applicable)
    max_delta    NUMERIC,                 -- the computed ceiling (if applicable)
    elapsed_sec  INTEGER,                 -- time window the delta was checked against
    severity     VARCHAR(16)  NOT NULL DEFAULT 'soft',  -- 'soft' (logged-only) | 'hard' (rejected at API)
    payload      JSONB,                   -- arbitrary kind-specific context
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS score_anomalies_discord_idx ON score_anomalies(discord_id, created_at DESC);
CREATE INDEX IF NOT EXISTS score_anomalies_kind_idx    ON score_anomalies(kind, created_at DESC);

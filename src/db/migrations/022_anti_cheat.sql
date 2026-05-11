-- Migration: anti-cheat foundation (issue #1, Phase 1).
--
-- Creates the score_anomalies append-only audit table. Phase 1 only WRITES to
-- it (clamp/reject events get a row); Phase 2 soak-watches it to tune the
-- Phase 3 thresholds. severity='soft' means clamped-with-warning (no behavior
-- change); severity='hard' means rejected at the API layer.
--
-- The original draft of this migration also added a `scores.last_sync_at`
-- column as a forge-proof elapsed-time anchor for the soft-cap calculation.
-- That column was removed once we realized `updated_at` (already server-set
-- on every score change via the model UPSERT) is functionally equivalent and
-- avoids the `SET NOT NULL` failure mode for any legacy row with a NULL
-- updated_at. anti-cheat code reads updated_at directly.

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

-- Migration: lift the BIGINT-driven 9.2e18 ceiling on scores.
--
-- Why: legacy column type was BIGINT (max 9,223,372,036,854,775,807 ≈ 9.2e18). The model code
-- already casts via ::NUMERIC in every query, but the underlying column would overflow once
-- a player legitimately accrued past 9.2e18 (post-H2 break_infinity migration enables this).
-- After H2, frontend SCORE_HARD_CAP is 1e308; we want the column to match that headroom.
--
-- Cast-in-place is safe — Postgres casts BIGINT → NUMERIC losslessly. This is a metadata-only
-- ALTER for existing rows with the right plan; for very large tables it can rewrite, but the
-- scores table is small (one row per Discord account).
--
-- The application-layer SCORE_CAP constant in src/models/score.model.js bumps in the same PR.
-- INFINITY_THRESHOLD (Number.MAX_SAFE_INTEGER) is unchanged — it's the speedrun milestone,
-- separate from the score ceiling.

ALTER TABLE scores ALTER COLUMN score TYPE NUMERIC USING score::numeric;

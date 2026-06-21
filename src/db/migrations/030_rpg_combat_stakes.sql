-- 030: Combat stakes — Downed state, lifetime/daily down tracking, and the
-- gated max-level "shaken confidence" penalty (see COMBAT_STAKES_V1.md).
--
-- A cat is "Downed" while downed_until is in the future (lazy, like stamina
-- regen — no status column needed). lifetime_downs drives the rest timer +
-- revive cost; downs_today (+ its date) drives the 2-downs-in-a-day penalty;
-- max_level_reduction lowers the cat's obtainable cap; confidence_restores
-- escalates the Confidence Treat catnip sink.

ALTER TABLE player_cat_stats ADD COLUMN IF NOT EXISTS downed_until        TIMESTAMPTZ;
ALTER TABLE player_cat_stats ADD COLUMN IF NOT EXISTS lifetime_downs      INTEGER  NOT NULL DEFAULT 0;
ALTER TABLE player_cat_stats ADD COLUMN IF NOT EXISTS downs_today         INTEGER  NOT NULL DEFAULT 0;
ALTER TABLE player_cat_stats ADD COLUMN IF NOT EXISTS downs_today_date    DATE;
ALTER TABLE player_cat_stats ADD COLUMN IF NOT EXISTS max_level_reduction SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE player_cat_stats ADD COLUMN IF NOT EXISTS confidence_restores SMALLINT NOT NULL DEFAULT 0;

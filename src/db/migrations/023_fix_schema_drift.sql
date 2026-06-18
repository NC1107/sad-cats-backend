-- Fix schema drift that breaks a freshly-migrated deploy and corrupts large/fractional writes.
--
-- 1. cat_bosses.week_key was declared NOT NULL UNIQUE in 006. Migration 008 dropped the
--    UNIQUE constraint (moving to a composite spawn_date+boss_name key) but left NOT NULL
--    in place. Every boss INSERT passes week_key = NULL, so on a database built purely from
--    the committed migrations (which now run on boot) every boss spawn throws a not-null
--    violation — and the error is swallowed, so no bosses ever spawn. Production only works
--    because the column was altered by hand pre-tracking. Drop NOT NULL so the column matches
--    how the code actually uses it.
--
-- 2. gambling_net (012), boss HP/damage/reward (006) are BIGINT but written with ::NUMERIC /
--    arbitrary deltas. A fractional delta throws (22P02) and a value past 9.2e18 overflows —
--    either failure aborts the whole score/boss UPDATE. Migration 021 lifted `score` to NUMERIC
--    for exactly this reason but left these columns behind. Cast them in place (BIGINT → NUMERIC
--    is lossless). These tables are tiny (one row per account / per boss), so the rewrite is cheap.
--
-- All statements are idempotent: DROP NOT NULL is a no-op if already nullable, and re-casting an
-- already-NUMERIC column is a no-op.

ALTER TABLE cat_bosses ALTER COLUMN week_key DROP NOT NULL;

ALTER TABLE scores ALTER COLUMN gambling_net TYPE NUMERIC USING gambling_net::numeric;

ALTER TABLE cat_bosses ALTER COLUMN max_hp      TYPE NUMERIC USING max_hp::numeric;
ALTER TABLE cat_bosses ALTER COLUMN current_hp  TYPE NUMERIC USING current_hp::numeric;
ALTER TABLE cat_bosses ALTER COLUMN reward_pool TYPE NUMERIC USING reward_pool::numeric;

ALTER TABLE boss_contributions ALTER COLUMN damage_dealt  TYPE NUMERIC USING damage_dealt::numeric;
ALTER TABLE boss_contributions ALTER COLUMN reward_amount TYPE NUMERIC USING reward_amount::numeric;

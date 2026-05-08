-- Add boss level, buff duration, and spawn_date to cat_bosses
ALTER TABLE cat_bosses ADD COLUMN IF NOT EXISTS boss_level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cat_bosses ADD COLUMN IF NOT EXISTS buff_duration_minutes INTEGER NOT NULL DEFAULT 1440;
ALTER TABLE cat_bosses ADD COLUMN IF NOT EXISTS spawn_date DATE NOT NULL DEFAULT CURRENT_DATE;

-- Replace week_key unique constraint with composite unique on spawn_date + boss_name
-- (allows multiple bosses per day, but no duplicate names on same day)
ALTER TABLE cat_bosses DROP CONSTRAINT IF EXISTS cat_bosses_week_key_key;
ALTER TABLE cat_bosses ADD CONSTRAINT cat_bosses_spawn_date_name_key UNIQUE (spawn_date, boss_name);

-- Index for daily queries
CREATE INDEX IF NOT EXISTS idx_cat_bosses_spawn_date ON cat_bosses(spawn_date);

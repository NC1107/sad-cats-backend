-- Speedrun rework: track best run time and current run start
-- best_speedrun_seconds: fastest time from run start to infinity (NULL = never reached)
-- speedrun_run_start: when the current run started (prestige/ascension resets this)
ALTER TABLE scores ADD COLUMN IF NOT EXISTS best_speedrun_seconds NUMERIC;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS speedrun_run_start TIMESTAMPTZ;

-- Seed run start for existing players (use account creation as first run start)
UPDATE scores SET speedrun_run_start = created_at WHERE speedrun_run_start IS NULL;

-- Index for speedrun leaderboard
CREATE INDEX IF NOT EXISTS idx_scores_best_speedrun ON scores(best_speedrun_seconds)
  WHERE best_speedrun_seconds IS NOT NULL;

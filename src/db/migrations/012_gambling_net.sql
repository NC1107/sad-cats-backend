-- Track net gambling profit/loss per player
ALTER TABLE scores ADD COLUMN IF NOT EXISTS gambling_net BIGINT NOT NULL DEFAULT 0;

-- Index for gambling leaderboard
CREATE INDEX IF NOT EXISTS idx_scores_gambling_net ON scores(gambling_net DESC)
  WHERE gambling_net != 0;

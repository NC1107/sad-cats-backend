-- Item 7: Allow negative scores (rob debt mechanic)
ALTER TABLE scores DROP CONSTRAINT IF EXISTS score_non_negative;

-- Item 5: Track infinity milestone for speedrun leaderboard
ALTER TABLE scores ADD COLUMN IF NOT EXISTS infinity_reached_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scores_infinity ON scores(infinity_reached_at)
  WHERE infinity_reached_at IS NOT NULL;

-- Item 8: Inventory shards (boss kill rewards)
CREATE TABLE IF NOT EXISTS inventory_shards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discord_id VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  shard_type VARCHAR(32) NOT NULL,
  tier INTEGER NOT NULL,
  quality NUMERIC(6,4) NOT NULL,
  quality_name VARCHAR(32) NOT NULL,
  boss_name VARCHAR(128) NOT NULL,
  boss_level INTEGER NOT NULL DEFAULT 1,
  source_boss_id INTEGER REFERENCES cat_bosses(id),
  obtained_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT quality_range CHECK (quality >= 0 AND quality <= 1),
  CONSTRAINT tier_range CHECK (tier >= 1 AND tier <= 5)
);
CREATE INDEX IF NOT EXISTS idx_shards_discord_id ON inventory_shards(discord_id);
CREATE INDEX IF NOT EXISTS idx_shards_obtained ON inventory_shards(obtained_at DESC);

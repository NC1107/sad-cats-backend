-- 013: Add missing indexes and boss shard distribution tracking table

-- Boss spawn date lookup
CREATE INDEX IF NOT EXISTS idx_cat_bosses_spawn_date ON cat_bosses(spawn_date);

-- Boss contributions composite index
CREATE INDEX IF NOT EXISTS idx_boss_contributions_boss_discord
  ON boss_contributions(boss_id, discord_id);

-- Boss buff lookup (only rows with active buffs)
CREATE INDEX IF NOT EXISTS idx_boss_contributions_user_buff
  ON boss_contributions(discord_id, buff_expires_at)
  WHERE buff_expires_at IS NOT NULL;

-- Idempotent shard distribution tracking (C9)
CREATE TABLE IF NOT EXISTS boss_shard_distributions (
  boss_id INTEGER PRIMARY KEY REFERENCES cat_bosses(id),
  distributed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Weekly community cat boss tables
CREATE TABLE IF NOT EXISTS cat_bosses (
  id SERIAL PRIMARY KEY,
  week_key VARCHAR(10) NOT NULL UNIQUE,
  boss_name VARCHAR(255) NOT NULL,
  boss_emoji VARCHAR(10) NOT NULL,
  max_hp BIGINT NOT NULL,
  current_hp BIGINT NOT NULL,
  defeated BOOLEAN DEFAULT FALSE,
  defeated_at TIMESTAMPTZ,
  reward_pool BIGINT NOT NULL DEFAULT 0,
  contributor_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS boss_contributions (
  id SERIAL PRIMARY KEY,
  boss_id INTEGER REFERENCES cat_bosses(id) ON DELETE CASCADE,
  discord_id VARCHAR(255) NOT NULL,
  username VARCHAR(255) NOT NULL,
  damage_dealt BIGINT DEFAULT 0,
  reward_claimed BOOLEAN DEFAULT FALSE,
  reward_amount BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(boss_id, discord_id)
);

CREATE INDEX IF NOT EXISTS idx_boss_contributions_boss_id ON boss_contributions(boss_id);
CREATE INDEX IF NOT EXISTS idx_boss_contributions_discord_id ON boss_contributions(discord_id);

-- Player case inventory (unopened cases)
CREATE TABLE IF NOT EXISTS player_cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discord_id VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  case_tier VARCHAR(32) NOT NULL,
  source VARCHAR(32) DEFAULT 'combine',
  obtained_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_player_cases_discord ON player_cases(discord_id);

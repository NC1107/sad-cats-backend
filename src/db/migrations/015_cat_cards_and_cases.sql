-- 015: Cat cards collection system + case opening history + catnip currency

-- Card sets (themed collections)
CREATE TABLE IF NOT EXISTS card_sets (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  bonus_type VARCHAR(16),
  bonus_value NUMERIC(6,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cat card catalog (admin-seeded, defines all collectible cats)
CREATE TABLE IF NOT EXISTS cat_cards (
  id VARCHAR(64) PRIMARY KEY,
  cat_name VARCHAR(128) NOT NULL,
  sprite_file VARCHAR(256) NOT NULL,
  rarity VARCHAR(16) NOT NULL,
  set_id VARCHAR(64) REFERENCES card_sets(id),
  buff_type VARCHAR(16),
  buff_value NUMERIC(6,4) DEFAULT 0,
  fun_stats JSONB,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cat_cards_rarity ON cat_cards(rarity);
CREATE INDEX IF NOT EXISTS idx_cat_cards_set ON cat_cards(set_id);

-- Player's card collection (each row = one owned card instance)
CREATE TABLE IF NOT EXISTS player_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discord_id VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  card_id VARCHAR(64) NOT NULL REFERENCES cat_cards(id),
  obtained_at TIMESTAMPTZ DEFAULT NOW(),
  source VARCHAR(32) DEFAULT 'case',
  is_duplicate BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_player_cards_discord ON player_cards(discord_id);
CREATE INDEX IF NOT EXISTS idx_player_cards_card ON player_cards(card_id);

-- Case opening history
CREATE TABLE IF NOT EXISTS case_opens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discord_id VARCHAR(255) NOT NULL,
  case_type VARCHAR(32) NOT NULL,
  toys_consumed JSONB,
  card_id VARCHAR(64) REFERENCES cat_cards(id),
  rarity VARCHAR(16) NOT NULL,
  was_pity BOOLEAN DEFAULT FALSE,
  was_duplicate BOOLEAN DEFAULT FALSE,
  catnip_received INTEGER DEFAULT 0,
  opened_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_case_opens_discord ON case_opens(discord_id);

-- Add catnip currency column to scores table
ALTER TABLE scores ADD COLUMN IF NOT EXISTS catnip INTEGER DEFAULT 0;

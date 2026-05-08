-- Add game_state column for cross-device game state sync
-- Stores upgrades, prestige level, lifetime earnings, achievements
ALTER TABLE scores ADD COLUMN IF NOT EXISTS game_state JSONB DEFAULT NULL;

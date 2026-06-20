-- 024: RPG layer — per-instance cat progression (level / XP / stamina).
--
-- Attaches to a card INSTANCE (player_cards.id), not (discord_id, card_id), so
-- duplicates are individually levelable and the party can reference distinct copies.
-- Rows are created LAZILY (first mutation); reads COALESCE a missing row to level 1,
-- so existing collections need no eager backfill.
--
-- All progression columns are native INTEGER/SMALLINT (never NUMERIC) so the
-- OID-20/1700 → String parser in config/database.js never touches them and they
-- parse back as JS numbers. Derived combat stats (HP/ATK/DEF/SPD/CRIT) are NOT
-- stored — they are computed on read from cat_cards + level (see utils/rpgStats.js).

CREATE TABLE IF NOT EXISTS player_cat_stats (
  player_card_id     UUID PRIMARY KEY REFERENCES player_cards(id) ON DELETE CASCADE,
  discord_id         VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  card_id            VARCHAR(64)  NOT NULL REFERENCES cat_cards(id),
  level              INTEGER  NOT NULL DEFAULT 1  CHECK (level >= 1),
  xp                 INTEGER  NOT NULL DEFAULT 0  CHECK (xp >= 0),   -- xp within current level
  stamina            SMALLINT NOT NULL DEFAULT 100 CHECK (stamina >= 0),
  stamina_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),             -- anchor for lazy regen on read
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcs_discord ON player_cat_stats(discord_id);
CREATE INDEX IF NOT EXISTS idx_pcs_card    ON player_cat_stats(card_id);

-- Tracks the one-time "starter XP gift" backfill so it only runs once per player
-- (granted on their first GET /api/rpg/cats). Presence of a row = already gifted.
CREATE TABLE IF NOT EXISTS rpg_starter_grants (
  discord_id  VARCHAR(255) PRIMARY KEY REFERENCES scores(discord_id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

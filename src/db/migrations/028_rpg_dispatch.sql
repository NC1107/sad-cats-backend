-- 028: RPG layer — dispatch quests (time-gated, idle-friendly).
--
-- Send cats away on a timer for catnip + XP. Cats in an active (uncollected)
-- dispatch are unavailable for combat/other dispatches — that's the opportunity
-- cost. ends_at is server-set; rewards are derived from the quest tier at
-- collect time. `collected` is the idempotency guard (collect once).

CREATE TABLE IF NOT EXISTS player_dispatches (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discord_id   VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  quest_id     VARCHAR(64)  NOT NULL,
  started_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ends_at      TIMESTAMPTZ  NOT NULL,
  collected    BOOLEAN      NOT NULL DEFAULT FALSE,
  collected_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dispatch_discord ON player_dispatches(discord_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_active  ON player_dispatches(discord_id) WHERE collected = FALSE;

CREATE TABLE IF NOT EXISTS player_dispatch_members (
  dispatch_id    UUID NOT NULL REFERENCES player_dispatches(id) ON DELETE CASCADE,
  player_card_id UUID NOT NULL REFERENCES player_cards(id) ON DELETE CASCADE,
  PRIMARY KEY (dispatch_id, player_card_id)
);

-- 025: RPG layer — active party (up to 4 cats).
--
-- One row per occupied slot. The two UNIQUE constraints enforce the invariant
-- that a player has at most 4 distinct cats, one per slot 0–3, with no cat in
-- two slots. setParty rewrites the party in a transaction (delete-then-insert)
-- after validating ownership + not-dispatched/not-in-combat in the controller.

CREATE TABLE IF NOT EXISTS player_party (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discord_id     VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  player_card_id UUID NOT NULL REFERENCES player_cards(id) ON DELETE CASCADE,
  slot           SMALLINT NOT NULL CHECK (slot BETWEEN 0 AND 3),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (discord_id, slot),
  UNIQUE (discord_id, player_card_id)
);

CREATE INDEX IF NOT EXISTS idx_player_party_discord ON player_party(discord_id);

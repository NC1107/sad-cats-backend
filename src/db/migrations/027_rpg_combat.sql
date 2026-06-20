-- 027: RPG layer — combat session summaries.
--
-- Combat is resolved entirely server-side (rpg-combat.service) in a single
-- /combat/start round-trip; we persist only the SUMMARY, not per-turn state.
-- `seed` makes the fight deterministic/auditable (re-derivable from the same
-- party snapshot). xp/catnip are integers; sc_reward is reserved for the later
-- SC-reward wiring (currently always 0 — combat grants XP + catnip only).

CREATE TABLE IF NOT EXISTS combat_sessions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  discord_id     VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  encounter_id   VARCHAR(64)  NOT NULL,
  party_snapshot JSONB        NOT NULL,
  seed           BIGINT       NOT NULL,
  result         VARCHAR(16)  NOT NULL,   -- win | loss
  turns          SMALLINT     NOT NULL DEFAULT 0,
  sc_reward      NUMERIC      NOT NULL DEFAULT 0,
  xp_granted     INTEGER      NOT NULL DEFAULT 0,
  catnip_granted INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_combat_discord ON combat_sessions(discord_id, created_at DESC);

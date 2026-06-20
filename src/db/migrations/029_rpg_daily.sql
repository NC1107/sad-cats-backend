-- 029: RPG layer — daily quest claims.
--
-- Daily cat quests track progress from existing data (combat_sessions /
-- player_dispatches counted for "today" UTC), so only CLAIMS need persisting.
-- Composite PK (discord_id, quest_date, quest_id) makes each quest claimable
-- once per UTC day and is the idempotency guard.

CREATE TABLE IF NOT EXISTS player_daily_claims (
  discord_id VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  quest_date DATE         NOT NULL,
  quest_id   VARCHAR(64)  NOT NULL,
  claimed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (discord_id, quest_date, quest_id)
);

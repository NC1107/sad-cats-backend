-- 026: RPG layer — story chain progress ("Nine Districts of Sad Cat City").
--
-- Linear node chain (9 chapters x 5 nodes). player_story_progress tracks the
-- furthest unlocked node; player_story_claims is a composite-PK idempotency
-- guard so a guaranteed chapter-reward card is granted at most once even under
-- retries (the non-RNG card acquisition path).

CREATE TABLE IF NOT EXISTS player_story_progress (
  discord_id   VARCHAR(255) PRIMARY KEY REFERENCES scores(discord_id),
  current_node VARCHAR(64)  NOT NULL DEFAULT 'ch1_n1',
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_story_claims (
  discord_id VARCHAR(255) NOT NULL REFERENCES scores(discord_id),
  node_id    VARCHAR(64)  NOT NULL,
  claimed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (discord_id, node_id)
);

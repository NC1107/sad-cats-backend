-- 014: Rename shards to cat toys across the schema

-- Rename table
ALTER TABLE IF EXISTS inventory_shards RENAME TO inventory_toys;

-- Rename column
ALTER TABLE inventory_toys RENAME COLUMN shard_type TO toy_type;

-- Recreate indexes with new names
DROP INDEX IF EXISTS idx_shards_discord_id;
DROP INDEX IF EXISTS idx_shards_obtained;
CREATE INDEX IF NOT EXISTS idx_toys_discord_id ON inventory_toys(discord_id);
CREATE INDEX IF NOT EXISTS idx_toys_obtained ON inventory_toys(obtained_at DESC);

-- Rename distribution tracking table
ALTER TABLE IF EXISTS boss_shard_distributions RENAME TO boss_toy_distributions;

-- Update toy_type values: old shard types -> new toy types
UPDATE inventory_toys SET toy_type = CASE
  WHEN toy_type = 'fragment' THEN 'yarn_ball'
  WHEN toy_type = 'splinter' THEN 'feather_wand'
  WHEN toy_type = 'core' THEN 'laser_pointer'
  WHEN toy_type = 'essence' THEN 'catnip_mouse'
  WHEN toy_type = 'nexus' THEN 'scratching_post'
  ELSE toy_type
END
WHERE toy_type IN ('fragment', 'splinter', 'core', 'essence', 'nexus');

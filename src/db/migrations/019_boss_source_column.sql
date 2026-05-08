-- Add source column to track how a boss was spawned (scheduled vs surge)
ALTER TABLE cat_bosses ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'scheduled';

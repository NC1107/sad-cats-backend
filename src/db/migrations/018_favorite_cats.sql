-- Add favorite_cats column to scores table (array of up to 5 card IDs)
ALTER TABLE scores ADD COLUMN IF NOT EXISTS favorite_cats JSONB DEFAULT '[]';

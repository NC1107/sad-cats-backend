-- Persist per-boss reward metadata so buffs can vary by boss identity + level
ALTER TABLE boss_contributions
  ADD COLUMN IF NOT EXISTS buff_type VARCHAR(32);

ALTER TABLE boss_contributions
  ADD COLUMN IF NOT EXISTS buff_multiplier NUMERIC(10,4);

ALTER TABLE boss_contributions
  ADD COLUMN IF NOT EXISTS buff_label VARCHAR(128);

ALTER TABLE boss_contributions
  ADD COLUMN IF NOT EXISTS buff_duration_minutes INTEGER;

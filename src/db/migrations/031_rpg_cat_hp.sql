-- 031: Combat attrition — persistent HP between fights.
--
-- current_hp is the cat's HP as of hp_updated_at; effective HP is computed on
-- read by regenerating toward max over ~15 min (lazy, like stamina/downed).
-- NULL current_hp = full. Combat starts each cat from its effective HP; on a
-- win, survivors keep their remaining HP (KO'd-on-win revive to 25% max); on a
-- loss the downed system takes over (a recovered/revived cat is full again).

ALTER TABLE player_cat_stats ADD COLUMN IF NOT EXISTS current_hp     INTEGER;
ALTER TABLE player_cat_stats ADD COLUMN IF NOT EXISTS hp_updated_at  TIMESTAMPTZ;

-- Upgrade score column from INTEGER to BIGINT to support values > 2.1 billion
-- BIGINT max: 9,223,372,036,854,775,807
-- JS Number.MAX_SAFE_INTEGER: 9,007,199,254,740,991 (practical limit)
ALTER TABLE scores ALTER COLUMN score TYPE BIGINT;

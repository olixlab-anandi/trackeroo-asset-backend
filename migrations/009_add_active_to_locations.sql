ALTER TABLE locations ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
UPDATE locations SET active = true WHERE active IS NULL;


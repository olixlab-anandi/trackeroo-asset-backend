-- 006_make_assets_location_nullable.sql
BEGIN;

-- If there is a FK already, keep it. We only drop the NOT NULL constraint.
ALTER TABLE assets
  ALTER COLUMN location_id DROP NOT NULL;

COMMIT;

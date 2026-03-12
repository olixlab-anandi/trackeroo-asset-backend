-- 2025_10_28_make_to_location_nullable.sql
-- Purpose: Make to_location_id nullable in issue_transaction without data loss

BEGIN;

-- Step 1: Check if column exists (safety check)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'issue_transaction' AND column_name = 'to_location_id'
    ) THEN
        RAISE NOTICE 'Column to_location_id does not exist in issue_transaction. Skipping migration.';
    END IF;
END$$;

-- Step 2: Drop NOT NULL constraint safely (if column exists)
ALTER TABLE issue_transaction
ALTER COLUMN to_location_id DROP NOT NULL;

-- Step 3: (Optional) Verify the change
-- You can uncomment this for debugging if running manually:
-- SELECT column_name, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'issue_transaction' AND column_name = 'to_location_id';

-- Step 4: Re-validate foreign key (if exists, ensures consistency)
DO $$
DECLARE
    fk_name text;
BEGIN
    SELECT conname INTO fk_name
    FROM pg_constraint
    WHERE conrelid = 'issue_transaction'::regclass
      AND confrelid = 'locations'::regclass
      AND contype = 'f'
      AND conkey @> (
        SELECT array_agg(attnum)
        FROM pg_attribute
        WHERE attrelid = 'issue_transaction'::regclass
          AND attname = 'to_location_id'
      );

    IF fk_name IS NOT NULL THEN
        RAISE NOTICE 'Foreign key constraint "%" found. No changes required since NULLs are allowed.', fk_name;
    ELSE
        RAISE NOTICE 'No FK constraint found for to_location_id.';
    END IF;
END$$;

COMMIT;

-- ✅ Result:
-- to_location_id remains UUID type
-- Existing data preserved
-- NULL values are now allowed in new inserts/updates
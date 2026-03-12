-- Drop unique on serial_number, replace with plain index.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.assets'::regclass
      AND conname = 'assets_serial_number_key'
  ) THEN
    ALTER TABLE assets DROP CONSTRAINT assets_serial_number_key;
  END IF;
END $$;

-- Optional: if a unique index exists with a different name (older schema)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='assets'
      AND indexname='assets_serial_number_key'
  ) THEN
    DROP INDEX assets_serial_number_key;
  END IF;
END $$;

-- Create a non-unique index for fast lookup
CREATE INDEX IF NOT EXISTS idx_assets_serial_number ON assets (serial_number);

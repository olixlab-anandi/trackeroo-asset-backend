-- ============================================
-- Migration: Add custom field support and import mappings
-- ============================================

-- 1. Add JSONB column to assets for flexible attributes
ALTER TABLE assets
ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Create GIN index for fast search/filter on attributes
CREATE INDEX IF NOT EXISTS idx_assets_attributes_gin
  ON assets
  USING GIN (attributes);

-- 2. Table to store reusable import mappings (templates)
CREATE TABLE IF NOT EXISTS import_mappings (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name         text NOT NULL,          -- e.g., "Vendor A CSV Template"
    description  text,
    mapping_json jsonb NOT NULL,         -- header -> target (builtin/custom/ignore)
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 3. Link import_jobs to the mapping used
ALTER TABLE import_jobs
ADD COLUMN IF NOT EXISTS mapping_id uuid REFERENCES import_mappings(id);

-- 4. Snapshot mapping used at import time
ALTER TABLE import_jobs
ADD COLUMN IF NOT EXISTS mapping_snapshot jsonb;

-- 5. Optional: trigger to update updated_at on import_mappings
CREATE OR REPLACE FUNCTION trg_import_mappings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_import_mappings_updated_at ON import_mappings;

CREATE TRIGGER trg_import_mappings_updated_at
BEFORE UPDATE ON import_mappings
FOR EACH ROW
EXECUTE FUNCTION trg_import_mappings_updated_at();
 
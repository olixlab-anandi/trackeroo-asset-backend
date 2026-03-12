-- Add a new column `is_active` to the assets table
-- Default to TRUE (so existing assets remain active)
ALTER TABLE assets
ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Optional: backfill or sanity-check values
-- Uncomment if you want all rows explicitly set
-- UPDATE assets SET is_active = TRUE WHERE is_active IS NULL;

-- Add an index to optimize filters by active/inactive state
CREATE INDEX IF NOT EXISTS idx_assets_is_active ON assets (is_active);

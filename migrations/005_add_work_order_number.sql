-- Add built-in column for Work Order Number
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS work_order_number text;

-- Optional: index if you plan to search/filter by it
CREATE INDEX IF NOT EXISTS idx_assets_work_order_number
  ON assets (work_order_number);

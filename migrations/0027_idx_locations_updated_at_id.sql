CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_locations_updatedat_id
ON locations (updated_at, id);
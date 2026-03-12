CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_external_location_updatedat_id
ON external_location (updated_at, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movements_createdat_id
ON movements (created_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movements_asset_id
ON movements (asset_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movements_from_location_id
ON movements (from_location_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_movements_to_location_id
ON movements (to_location_id);
-- 002_bulk_import.sql
-- Bulk import, locations, assets, movements, import audit tables

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

-- 1) Locations (tree)
CREATE TABLE IF NOT EXISTS locations (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        citext      NOT NULL,
  parent_id   uuid        NULL REFERENCES locations(id) ON DELETE RESTRICT,
  path        text        NOT NULL,
  depth       int         NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_location_sibling UNIQUE (parent_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_path ON locations (path);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations (parent_id);

-- 2) Assets
CREATE TABLE IF NOT EXISTS assets (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  barcode           citext      NOT NULL UNIQUE,
  serial_number     citext      UNIQUE,
  title             text,
  category          text,
  status            text,
  tag               text,
  company_asset_id  text,
  part_name         text,
  part_description  text,
  type              text,
  location_id       uuid        NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_location ON assets (location_id);

-- 3) Movements (append-only)
CREATE TABLE IF NOT EXISTS movements (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  asset_id         uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  from_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  to_location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  reason           text NOT NULL,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movements_asset ON movements (asset_id);
CREATE INDEX IF NOT EXISTS idx_movements_to_loc ON movements (to_location_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON movements (created_at);

-- 4) Import audit
CREATE TABLE IF NOT EXISTS import_jobs (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  filename           text NOT NULL,
  file_hash          text NOT NULL,
  total_rows         int  NOT NULL,
  valid_rows         int  NOT NULL,
  invalid_rows       int  NOT NULL,
  created_assets     int  NOT NULL DEFAULT 0,
  updated_assets     int  NOT NULL DEFAULT 0,
  created_locations  int  NOT NULL DEFAULT 0,
  movements_logged   int  NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_jobs_hash ON import_jobs (file_hash);

CREATE TABLE IF NOT EXISTS import_job_items (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number    int  NOT NULL,
  barcode       text,
  location_path text,
  status        text NOT NULL,   -- 'created'|'updated'|'skipped'|'error'
  message       text,
  asset_id      uuid REFERENCES assets(id) ON DELETE SET NULL,
  location_id   uuid REFERENCES locations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_import_items_job ON import_job_items (job_id);

-- Updated_at triggers (use your existing trigger function if present)
-- DROP TRIGGER IF EXISTS trg_locations_updated_at ON locations;
-- CREATE TRIGGER trg_locations_updated_at BEFORE UPDATE ON locations
-- FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- DROP TRIGGER IF EXISTS trg_assets_updated_at ON assets;
-- CREATE TRIGGER trg_assets_updated_at BEFORE UPDATE ON assets
-- FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

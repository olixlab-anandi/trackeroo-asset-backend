-- =============================================================
-- 0028: COMPLETE MIGRATION — external_location (UUID-based)
-- =============================================================
-- This script safely:
--   1️⃣ Drops foreign keys referencing old external_location table
--   2️⃣ Drops existing external_location table (INT)
--   3️⃣ Creates new UUID-based external_location table
--   4️⃣ Adds external_location_id (UUID) columns + FKs to issue_transaction & movements
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

BEGIN;

-- STEP 1️⃣ — Drop dependent foreign keys if they exist
DO $$
DECLARE fk_name TEXT;
BEGIN
  -- issue_transaction
  SELECT constraint_name INTO fk_name
  FROM information_schema.constraint_column_usage
  WHERE table_name = 'issue_transaction' AND column_name = 'external_location_id'
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE issue_transaction DROP CONSTRAINT %I;', fk_name);
  END IF;
END $$;

DO $$
DECLARE fk_name TEXT;
BEGIN
  -- movements
  SELECT constraint_name INTO fk_name
  FROM information_schema.constraint_column_usage
  WHERE table_name = 'movements' AND column_name = 'external_location_id'
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE movements DROP CONSTRAINT %I;', fk_name);
  END IF;
END $$;

COMMIT;

-- STEP 2️⃣ — Drop old table if exists
DROP TABLE IF EXISTS external_location CASCADE;

-- STEP 3️⃣ — Create new external_location (UUID-based)
CREATE TABLE external_location (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type TEXT CHECK (type IN ('SUPPLIER','CUSTOMER','CONTRACTOR','PARTNER','VENDOR','OTHER')),
    company_name TEXT NOT NULL,
    contact_person TEXT,
    email TEXT,
    phone TEXT,
    address_line1 TEXT,
    address_line2 TEXT,
    city TEXT,
    state TEXT,
    postal_code TEXT,
    country TEXT,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE external_location IS 'Stores vendor, client, or contractor companies that assets can be issued to externally.';
COMMENT ON COLUMN external_location.type IS 'Category of external entity, e.g. SUPPLIER, CONTRACTOR, etc.';

-- STEP 4️⃣ — Add external_location_id to issue_transaction (UUID)
DO $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'issue_transaction' AND column_name = 'external_location_id'
  ) THEN
      ALTER TABLE issue_transaction ADD COLUMN external_location_id UUID;
  END IF;
END $$;

ALTER TABLE issue_transaction
  ADD CONSTRAINT issue_transaction_external_location_id_fkey
  FOREIGN KEY (external_location_id)
  REFERENCES external_location(id)
  ON DELETE SET NULL;

-- STEP 5️⃣ — Add external_location_id to movements (UUID)
DO $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'movements' AND column_name = 'external_location_id'
  ) THEN
      ALTER TABLE movements ADD COLUMN external_location_id UUID;
  END IF;
END $$;

ALTER TABLE movements
  ADD CONSTRAINT movements_external_location_id_fkey
  FOREIGN KEY (external_location_id)
  REFERENCES external_location(id)
  ON DELETE SET NULL;

-- STEP 6️⃣ — Seed data
INSERT INTO external_location (type, company_name, contact_person, email, phone, address_line1, city, state, postal_code, country)
VALUES
('CONTRACTOR', 'SageTech Solutions', 'Pal Mashruwala', 'pal@sagetechsolutions.com.au', '0406789867', '241/132G Jerralong Drive', 'Schofields', 'NSW', '2762', 'Australia'),
('CUSTOMER', 'AEMO', 'Ops Team', 'ops@aemo.com.au', '1300360700', '530 Collins Street', 'Melbourne', 'VIC', '3000', 'Australia');

-- STEP 7️⃣ — Verify structure
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('external_location','issue_transaction','movements')
AND column_name = 'external_location_id';

-- =============================================================
-- ✅ Done — new external_location (UUID) + linked FKs ready
-- =============================================================
/*
------------------------------------------------------------------------------
File: migrations/001_init.sql
Purpose:
  - Bootstrap the PostgreSQL schema for our Asset Tracking backend (single-tenant).
  - Creates core enums, tables, constraints, and helpful triggers.
  - Sets the foundation for authentication (users), organisations, and membership.

How to run (Windows PowerShell):
  set DATABASE_URL=postgres://assetuser:strongpassword@localhost:5432/assetdb && npm run migrate

Notes:
  - Requires PostgreSQL extensions: uuid-ossp (for UUIDs), citext (case-insensitive email).
  - If citext isn't available on your install, you can replace 'CITEXT' with 'VARCHAR(255)'
    and enforce lower-casing in the app layer. Using CITEXT is preferred for correctness.
------------------------------------------------------------------------------
*/

-- 1) Extensions (safe if already installed)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- UUID generation (uuid_generate_v4())
CREATE EXTENSION IF NOT EXISTS citext;        -- Case-insensitive text (great for emails)

-- 2) ENUM types
--    Using ENUMs keeps data clean & self-documenting. If you later add roles,
--    you can `ALTER TYPE ... ADD VALUE ...`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('super_admin','org_admin','member');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'org_role') THEN
    CREATE TYPE org_role  AS ENUM ('org_admin','member');
  END IF;
END $$;

-- 3) Organisations
--    Even though we’re single-tenant per deployment, we keep "organisations"
--    because your super admin can create the client org and its sub-admins/users.
CREATE TABLE IF NOT EXISTS organisations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(160) NOT NULL UNIQUE,          -- Human-friendly display name
  slug         VARCHAR(160) NOT NULL UNIQUE,          -- URL-safe unique slug (e.g., "acme-pty-ltd")
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 4) Users
--    Global users for this single deployment. Super Admin belongs to us; others
--    are client users. 'email' is CITEXT so comparisons are case-insensitive.
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         CITEXT NOT NULL UNIQUE,               -- Case-insensitive unique email
  password_hash TEXT   NOT NULL,                      -- Bcrypt hash
  name          VARCHAR(120) NOT NULL,
  role          user_role NOT NULL DEFAULT 'member',  -- Global role (super_admin/org_admin/member)
  is_active     BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5) Organisation Membership
--    A user can belong to the client organisation with a per-org role
--    (lets you delegate org administration without making global super admins).
CREATE TABLE IF NOT EXISTS org_users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  role          org_role NOT NULL DEFAULT 'member',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

-- 6) Updated-at trigger helper
--    Keeps 'updated_at' fresh automatically on UPDATEs.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach triggers to relevant tables
DROP TRIGGER IF EXISTS trg_orgs_updated_at  ON organisations;
CREATE TRIGGER trg_orgs_updated_at
BEFORE UPDATE ON organisations
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 7) Helpful indexes (beyond the UNIQUEs)
--    Speed up common lookups; you can add more as features expand.
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users (is_active);
CREATE INDEX IF NOT EXISTS idx_org_users_org   ON org_users (org_id);
CREATE INDEX IF NOT EXISTS idx_org_users_user  ON org_users (user_id);

-- 8) Sanity checks (optional)
--    Enforce minimal email format (in addition to app-level validation).
--    CITEXT does not change format; it just ignores case in comparisons.
--    Uncomment to enforce a simple regex:
-- ALTER TABLE users
--   ADD CONSTRAINT chk_users_email_format
--   CHECK (email ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$');

-- End of 001_init.sql

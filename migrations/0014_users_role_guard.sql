BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Normalize existing role values
UPDATE users
SET role = LOWER(role::text)::user_role;

UPDATE users
SET role = CASE
  WHEN role::text IN ('superadmin','super admin') THEN 'super_admin'::user_role
  WHEN role::text IN ('administrator','administrators') THEN 'admin'::user_role
  WHEN role::text IN ('portal','portaluser','portal-user') THEN 'portal_user'::user_role
  WHEN role::text IN ('mobile','mobileuser','mobile-user') THEN 'mobile_user'::user_role
  WHEN role::text IN ('portal+mobile','both','portal_mobile','portal-mobile')
    THEN 'portal_mobile_user'::user_role
  ELSE role
END;

-- Recreate the constraint (safe idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_role_chk'
    AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE users
    ADD CONSTRAINT users_role_chk
    CHECK (role IN ('super_admin','admin','portal_user','mobile_user','portal_mobile_user'));
  END IF;
END$$;

-- Delete existing super admins
DELETE FROM users WHERE role = 'super_admin';

-- Insert a new one
INSERT INTO users (email, password_hash, name, role, is_active, created_at, updated_at)
VALUES (
  'pal@sagetechsolutions.com.au',
  crypt('pal@1707', gen_salt('bf')),
  'Super Admin',
  'super_admin',
  TRUE,
  now(), now()
);

COMMIT;

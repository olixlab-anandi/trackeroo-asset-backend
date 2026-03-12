BEGIN;

-- 1. Rename the old ENUM column
ALTER TABLE users RENAME COLUMN role TO role_old;

-- 2. Add the new TEXT column
ALTER TABLE users ADD COLUMN role TEXT;

-- 3. Copy values from ENUM → TEXT
UPDATE users
SET role = role_old::text;

-- 4. Remove NOT NULL temporarily (optional)
ALTER TABLE users ALTER COLUMN role DROP NOT NULL;

-- 5. Drop the old ENUM column
ALTER TABLE users DROP COLUMN role_old;

-- 6. Drop ENUM TYPE safely
DROP TYPE IF EXISTS user_role;

COMMIT;
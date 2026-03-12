-- scripts/init_target.sql
-- Purpose:
--   1) Ensure required extensions exist in the application database
--   2) Execute the app migration(s)

-- 1) Extensions (safe to run multiple times)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

-- 2) Run your migration file(s)
--    Adjust the relative path if your folder names differ.
\i migrations/001_init.sql

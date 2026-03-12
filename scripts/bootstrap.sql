-- scripts/bootstrap.sql
-- Fully bootstrap the application role/database, idempotently.
-- Run as superuser on the default 'postgres' DB:
--   psql -U postgres -h 127.0.0.1 -p 5432 -d postgres -f scripts/bootstrap.sql

\pset pager off
\timing off

\echo ==== BOOTSTRAP: start ===============================================

-- >>>> CONFIGURE THESE VALUES <<<<
\set app_user 'assetuser'
\set app_pass 'Strong1234'     -- keep alphanumeric in dev to avoid URL-encoding
\set app_db   'assetdb'

\echo [0/6] Ensure password_encryption is scram-sha-256...
-- (This affects how the hash is stored when we run ALTER ROLE below.)
-- Note: This is a cluster setting; you can omit if your cluster already uses SCRAM.
ALTER SYSTEM SET password_encryption = 'scram-sha-256';
SELECT pg_reload_conf();

\echo [1/6] Ensure role :app_user exists WITH LOGIN and password...

-- Create role if missing (WITH LOGIN + password)
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

-- Always enforce LOGIN + password (updates verifier every run)
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_pass')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

\echo [2/6] Ensure database :app_db exists, owned by :app_user...

-- Create DB if missing (owned by app user)
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db')
\gexec

\echo [3/6] If :app_db exists but owner differs, transfer ownership...

WITH db AS (
  SELECT d.datname, r.rolname AS owner
  FROM pg_database d
  JOIN pg_roles r ON r.oid = d.datdba
  WHERE d.datname = :'app_db'
)
SELECT format('ALTER DATABASE %I OWNER TO %I', :'app_db', :'app_user')
FROM db
WHERE db.owner <> :'app_user'
\gexec

\echo [4/6] Connect to :app_db and ensure schema ownership + defaults...

\connect :app_db

-- Make 'public' schema owned by app_user if not already
WITH s AS (
  SELECT n.nspname AS schema, r.rolname AS owner
  FROM pg_namespace n
  JOIN pg_roles r ON r.oid = n.nspowner
  WHERE n.nspname = 'public'
)
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_user')
FROM s
WHERE s.owner <> :'app_user'
\gexec

-- Ensure grants on the schema for the owner (idempotent)
GRANT ALL ON SCHEMA public TO :app_user;

-- Ensure default privileges for future objects in this schema
ALTER DEFAULT PRIVILEGES FOR USER :app_user IN SCHEMA public
GRANT ALL ON TABLES TO :app_user;
ALTER DEFAULT PRIVILEGES FOR USER :app_user IN SCHEMA public
GRANT ALL ON SEQUENCES TO :app_user;

\echo [5/6] Verification summary (LOGIN flag and stored password hash presence)...

\connect postgres

-- Show LOGIN flag
SELECT rolname,
       rolcanlogin AS has_login
FROM pg_roles
WHERE rolname = :'app_user';

-- Show whether a password hash exists (superuser-only view)
-- rolpassword is the hashed verifier; should be non-NULL after ALTER ROLE above.
SELECT rolname,
       (rolpassword IS NOT NULL) AS has_password_hash
FROM pg_authid
WHERE rolname = :'app_user';

-- Show DB owner
SELECT d.datname   AS database,
       r.rolname   AS owner
FROM pg_database d
JOIN pg_roles r ON r.oid = d.datdba
WHERE d.datname = :'app_db';

\echo
\echo NOTE: After this, run your init script to install extensions/migrations:
\echo   psql -U postgres -h 127.0.0.1 -p 5432 -d :app_db -f scripts/init_target.sql

\echo ==== BOOTSTRAP: done ================================================

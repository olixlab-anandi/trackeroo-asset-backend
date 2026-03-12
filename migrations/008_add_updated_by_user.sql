CREATE EXTENSION IF NOT EXISTS citext;


-- ASSETS
ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS created_by_user CITEXT,
  ADD COLUMN IF NOT EXISTS updated_by_user CITEXT;

-- LOCATIONS
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS created_by_user CITEXT,
  ADD COLUMN IF NOT EXISTS updated_by_user CITEXT;

-- MOVEMENTS
ALTER TABLE public.movements
  ADD COLUMN IF NOT EXISTS created_by_user CITEXT;

-- IMPORT JOBS
ALTER TABLE public.import_jobs
  ADD COLUMN IF NOT EXISTS created_by_user CITEXT;

-- IMPORT JOB ITEMS
ALTER TABLE public.import_job_items
  ADD COLUMN IF NOT EXISTS created_by_user CITEXT;

--lightweight indexes if filter by user
CREATE INDEX IF NOT EXISTS idx_assets_created_by_user  ON public.assets (created_by_user);
CREATE INDEX IF NOT EXISTS idx_assets_updated_by_user  ON public.assets (updated_by_user);

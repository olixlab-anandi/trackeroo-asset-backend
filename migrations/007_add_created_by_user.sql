ALTER TABLE assets        ADD COLUMN created_by_user citext;
ALTER TABLE locations     ADD COLUMN created_by_user citext;
ALTER TABLE movements     ADD COLUMN created_by_user citext;
ALTER TABLE import_jobs   ADD COLUMN created_by_user citext;
ALTER TABLE import_job_items ADD COLUMN created_by_user citext;

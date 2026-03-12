-- 010_drop_issue_return_schema.sql
-- Rollback migration: removes issue/return schema + notifications
-- WARNING: Dropping columns will lose data written to them.

BEGIN;

-- 1) Drop the view
DROP VIEW IF EXISTS v_open_issue_items;

-- 2) Drop indexes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ux_issue_item_open_asset') THEN
    DROP INDEX ux_issue_item_open_asset;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_movements_asset') THEN
    DROP INDEX ix_movements_asset;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_movements_ref') THEN
    DROP INDEX ix_movements_ref;
  END IF;
END$$;

-- 3) Drop feature tables
DROP TABLE IF EXISTS email_log;
DROP TABLE IF EXISTS notification_rules;
DROP TABLE IF EXISTS asset_status_history;
DROP TABLE IF EXISTS issue_item;
DROP TABLE IF EXISTS issue_transaction;

-- 4) Revert movements table
ALTER TABLE movements
  DROP COLUMN IF EXISTS ref_type,
  DROP COLUMN IF EXISTS ref_id;

COMMIT;

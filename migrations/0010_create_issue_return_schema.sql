-- 010_create_issue_return_schema.sql
-- Forward migration: adds issue/return schema + notifications + status history
-- Depends on existing: assets, locations, movements

BEGIN;

-- 1) Extend movements with generic reference (for issue transactions, etc.)
ALTER TABLE movements
  ADD COLUMN IF NOT EXISTS ref_type text,
  ADD COLUMN IF NOT EXISTS ref_id uuid;

-- 2) Main transaction table
CREATE TABLE IF NOT EXISTS issue_transaction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_date      timestamptz NOT NULL DEFAULT now(),
  from_location_id uuid NOT NULL REFERENCES locations(id),
  to_location_id   uuid NOT NULL REFERENCES locations(id),
  due_date        date,
  status          text NOT NULL DEFAULT 'OPEN', -- OPEN / CLOSED / CANCELLED
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 3) Items within a transaction
CREATE TABLE IF NOT EXISTS issue_item (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      uuid NOT NULL REFERENCES issue_transaction(id) ON DELETE CASCADE,
  asset_id            uuid NOT NULL REFERENCES assets(id),
  issued_at           timestamptz NOT NULL DEFAULT now(),
  returned_at         timestamptz,
  status              text NOT NULL DEFAULT 'ISSUED', -- ISSUED / RETURNED / LOST
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Prevent asset from being in two open issue_items at once
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'ux_issue_item_open_asset'
  ) THEN
    CREATE UNIQUE INDEX ux_issue_item_open_asset
      ON issue_item(asset_id)
      WHERE status = 'ISSUED';
  END IF;
END$$;

-- 4) Asset status history (audit trail)
CREATE TABLE IF NOT EXISTS asset_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES assets(id),
  old_status  text,
  new_status  text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 5) Notification rules (admin-configurable)
CREATE TABLE IF NOT EXISTS notification_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL, -- ISSUE, DUE_SOON, OVERDUE, RETURNED
  email           text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 6) Email log (outbox / audit)
CREATE TABLE IF NOT EXISTS email_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid REFERENCES notification_rules(id),
  recipient       text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'SENT' -- SENT / FAILED
);

-- 7) Indexes for movements ref columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'ix_movements_asset'
  ) THEN
    CREATE INDEX ix_movements_asset ON movements(asset_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'ix_movements_ref'
  ) THEN
    CREATE INDEX ix_movements_ref ON movements(ref_type, ref_id);
  END IF;
END$$;

-- 8) Handy view: open issue items
CREATE OR REPLACE VIEW v_open_issue_items AS
SELECT ii.id, ii.asset_id, it.from_location_id, it.to_location_id,
       it.due_date, ii.issued_at
FROM issue_item ii
JOIN issue_transaction it ON it.id = ii.transaction_id
WHERE ii.status = 'ISSUED' AND it.status = 'OPEN';

COMMIT;

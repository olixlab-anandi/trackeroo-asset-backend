-- =====================================================================
-- Issue / Movement: minimal schema additions for edit/void flows
-- Safe to run multiple times (IF NOT EXISTS + DO/EXCEPTION blocks).
-- =====================================================================

BEGIN;

-- Ensure pgcrypto is available if you want gen_random_uuid() in the future
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- issue_transaction
-- ---------------------------------------------------------------------

ALTER TABLE issue_transaction
  ADD COLUMN IF NOT EXISTS reference           TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by_user   UUID,
  ADD COLUMN IF NOT EXISTS cancel_reason       TEXT;

-- Unique constraint on reference but allow NULLs
CREATE UNIQUE INDEX IF NOT EXISTS issue_transaction_reference_uq
  ON issue_transaction(reference)
  WHERE reference IS NOT NULL;

-- Optional: constrain status to the known set (OPEN, OVERDUE, CLOSED, VOID)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'issue_transaction_status_chk'
  ) THEN
    ALTER TABLE issue_transaction
      ADD CONSTRAINT issue_transaction_status_chk
      CHECK (status IN ('OPEN','OVERDUE','CLOSED','VOID'));
  END IF;
END$$;

-- ---------------------------------------------------------------------
-- issue_item
-- (You already have returned_at and status. Add a guard on status values.)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'issue_item_status_chk'
  ) THEN
    ALTER TABLE issue_item
      ADD CONSTRAINT issue_item_status_chk
      CHECK (status IN ('ISSUED','RETURNED','REMOVED','VOID'));
  END IF;
END$$;

-- Helpful index to list items for an issue quickly
CREATE INDEX IF NOT EXISTS issue_item_tx_idx
  ON issue_item (transaction_id);

-- ---------------------------------------------------------------------
-- movements
-- (You already have reason, note, created_by_user, ref_type, ref_id.)
-- Add optional reverse link to pair “reversal” movements.
-- ---------------------------------------------------------------------

ALTER TABLE movements
  ADD COLUMN IF NOT EXISTS reverse_movement_id UUID;

-- FK to itself; if the original is deleted, keep this row but null the link
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'movements_reverse_fk'
  ) THEN
    ALTER TABLE movements
      ADD CONSTRAINT movements_reverse_fk
      FOREIGN KEY (reverse_movement_id)
      REFERENCES movements(id)
      ON DELETE SET NULL;
  END IF;
END$$;

-- Helpful indexes for lookups by reference back to an issue
CREATE INDEX IF NOT EXISTS movements_ref_idx
  ON movements (ref_type, ref_id);

CREATE INDEX IF NOT EXISTS movements_asset_time_idx
  ON movements (asset_id, created_at);

-- ---------------------------------------------------------------------
-- Backfill: generate references for existing issues where missing.
-- Format: ISS-YYYYMMDD-00001 (order by created_at).
-- ---------------------------------------------------------------------
WITH numbered AS (
  SELECT
    it.id,
    'ISS-' ||
    to_char(COALESCE(it.issue_date, it.created_at), 'YYYYMMDD') ||
    '-' || lpad(ROW_NUMBER() OVER (ORDER BY it.created_at)::text, 5, '0') AS new_ref
  FROM issue_transaction it
  WHERE it.reference IS NULL
)
UPDATE issue_transaction it
SET reference = n.new_ref
FROM numbered n
WHERE it.id = n.id;


ALTER TABLE issue_item
  ADD COLUMN IF NOT EXISTS note TEXT;


ALTER TABLE issue_transaction
  ADD COLUMN IF NOT EXISTS created_by TEXT,     -- email of user who issued
  ADD COLUMN IF NOT EXISTS updated_by TEXT,              -- last user who edited
  ADD COLUMN IF NOT EXISTS returned_by TEXT,
  ADD COLUMN IF NOT EXISTS returned_at TEXT,
  ADD COLUMN IF NOT EXISTS voided_by TEXT,               -- user who voided
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;        -- timestamp when voided

ALTER TABLE issue_item
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT,
  ADD COLUMN IF NOT EXISTS returned_by TEXT,
  ADD COLUMN IF NOT EXISTS returned_at TEXT,
  ADD COLUMN IF NOT EXISTS voided_by TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;





COMMIT;

-- =====================================================================
-- Notes:
-- - Allowed movement reason values we’ll use in code:
--   'ISSUE', 'ISSUE_EDIT', 'ISSUE_VOID', 'RETURN'
-- - reverse_movement_id is optional; you can link a reversal to the
--   original movement when you “undo” part of an issue.
-- - The status CHECK constraints remain flexible (TEXT + whitelist).
-- =====================================================================

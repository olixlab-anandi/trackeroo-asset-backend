BEGIN;

-- Enable pg_trgm if not already
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Basic B-tree indexes for lookups and joins
CREATE INDEX IF NOT EXISTS idx_issue_transaction_from_location_id
    ON issue_transaction (from_location_id);

CREATE INDEX IF NOT EXISTS idx_issue_transaction_to_location_id
    ON issue_transaction (to_location_id);

CREATE INDEX IF NOT EXISTS idx_issue_transaction_status
    ON issue_transaction (status);

CREATE INDEX IF NOT EXISTS idx_issue_transaction_issue_date
    ON issue_transaction (issue_date);

CREATE INDEX IF NOT EXISTS idx_issue_transaction_due_date
    ON issue_transaction (due_date);

CREATE INDEX IF NOT EXISTS idx_issue_transaction_reference
    ON issue_transaction (reference);

CREATE INDEX IF NOT EXISTS idx_issue_transaction_created_at
    ON issue_transaction (created_at DESC);

-- Text search optimization for search bar (on reference, status, and user columns)
CREATE INDEX IF NOT EXISTS idx_issue_transaction_search
    ON issue_transaction
    USING gin (
        (coalesce(reference, '') || ' ' ||
         coalesce(status, '') || ' ' ||
         coalesce(cancel_reason, '')
        ) gin_trgm_ops
    );

COMMIT;

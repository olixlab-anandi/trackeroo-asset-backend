CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_transaction_updatedat_id
ON issue_transaction (updated_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_item_transaction_id
ON issue_item (transaction_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_item_transaction_createdat
ON issue_item (transaction_id, created_at);
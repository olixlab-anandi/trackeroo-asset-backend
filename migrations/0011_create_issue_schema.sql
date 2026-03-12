-- =====================================================================
-- Base schema for issue_transaction and issue_item
-- This matches the columns you currently have in your DB
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- issue_transaction
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issue_transaction (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_date TIMESTAMPTZ,
    from_location_id UUID,
    to_location_id UUID,
    due_date TIMESTAMPTZ,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------
-- issue_item
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issue_item (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES issue_transaction(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL,
    issued_at TIMESTAMPTZ,
    returned_at TIMESTAMPTZ,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

COMMIT;

-- =====================================================================
-- Notes:
-- - Primary keys are UUID with default gen_random_uuid()
-- - Relationships: issue_item.transaction_id → issue_transaction.id
-- - You already have movements, so not recreated here.
-- =====================================================================

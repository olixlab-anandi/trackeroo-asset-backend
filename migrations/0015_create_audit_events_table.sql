-- 0015_create_audit_events.sql
BEGIN;

-- requires pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid,        -- users.id
  actor_email     text,
  action          text NOT NULL,       -- e.g. ISSUE_CREATE, RETURN_CREATE, MOVE_INTERNAL, MOVE_EDIT, VOID_ISSUE, BULK_IMPORT
  entity_type     text NOT NULL,       -- e.g. 'asset','movement','issue','return','import','user','location','setting'
  entity_id       uuid,                -- the primary entity (asset id for ISSUE/RETURN/MOVE; movement id for MOVE_EDIT, etc.)
  ref_type        text,                -- optional secondary entity type (movement/issue/return/import)
  ref_id          uuid,                -- optional secondary entity id
  summary         text,                -- human readable short description
  before_data     jsonb,               -- optional before
  after_data      jsonb                -- optional after
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_audit_events_time     ON audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity   ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_action   ON audit_events (action);

-- Trigger to log edits on movements (e.g., editing note)
CREATE OR REPLACE FUNCTION log_movement_update() RETURNS trigger AS $$
BEGIN
  IF row_to_json(NEW) IS DISTINCT FROM row_to_json(OLD) THEN
    INSERT INTO audit_events(
      action, entity_type, entity_id, ref_type, ref_id,
      summary, before_data, after_data
    )
    VALUES (
      'MOVE_EDIT', 'movement', NEW.id, NULL, NULL,
      'Movement updated',
      to_jsonb(OLD), to_jsonb(NEW)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movements_audit ON movements;
CREATE TRIGGER trg_movements_audit
AFTER UPDATE ON movements
FOR EACH ROW EXECUTE FUNCTION log_movement_update();

COMMIT;

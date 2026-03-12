CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx ON audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_email_idx ON audit_events (actor_email);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id);
-- If free text is heavy, consider pg_trgm on summary and JSON text:
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS audit_events_summary_trgm ON audit_events USING gin (summary gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_events_before_text_trgm ON audit_events USING gin ((before_data::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_events_after_text_trgm  ON audit_events USING gin ((after_data::text) gin_trgm_ops);

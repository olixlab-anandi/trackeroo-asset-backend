ALTER TABLE notification_rules 
    ADD COLUMN IF NOT EXISTS event_type text,
    ADD COLUMN IF NOT EXISTS is_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS recipients TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    ADD COLUMN IF NOT EXISTS cc TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    ADD COLUMN IF NOT EXISTS bcc TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    ADD COLUMN IF NOT EXISTS  updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS   updated_by TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_rules_event ON notification_rules (event_type);

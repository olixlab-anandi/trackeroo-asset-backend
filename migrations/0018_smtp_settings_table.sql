CREATE TABLE IF NOT EXISTS smtp_settings (
  id               bigserial PRIMARY KEY,
  is_enabled       boolean NOT NULL DEFAULT false,
  host             text NOT NULL,
  port             integer NOT NULL DEFAULT 587,
  secure           boolean NOT NULL DEFAULT false,
  username         text NOT NULL,
  password_enc     text NOT NULL,              -- encrypted at rest (app-level)
  from_name        text NOT NULL,
  from_email       text NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid                         -- users.id
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_smtp_settings_singleton ON smtp_settings ((true));

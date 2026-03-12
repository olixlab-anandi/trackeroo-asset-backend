-- 001_create_idempotency_keys.sql
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id BIGSERIAL PRIMARY KEY,

  key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  method TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,

  state TEXT NOT NULL DEFAULT 'IN_PROGRESS', -- IN_PROGRESS | COMPLETED

  status_code INT,
  response_body JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_idempotency_user_key
  ON idempotency_keys (user_id, key);

CREATE INDEX IF NOT EXISTS ix_idempotency_created_at
  ON idempotency_keys (created_at);
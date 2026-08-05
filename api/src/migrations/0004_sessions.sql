-- Story 1.2: phiên server-side (AD-8) — refresh_token CHỈ nằm ở đây, không bao giờ ra API/log
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_sub text NOT NULL REFERENCES users(sub),
  refresh_token text,
  access_token_exp timestamptz,
  claims jsonb,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_sub ON sessions (user_sub);

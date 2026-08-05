-- Story 1.2 (nền cho 1.4): audit_log APPEND-ONLY (AD-10)
-- CẤM mọi UPDATE/DELETE trỏ vào bảng này trong toàn bộ codebase.
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  object_type text,
  object_id text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at);

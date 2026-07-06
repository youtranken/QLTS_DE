-- Story 1.2: bảng users — khóa chính = claim `sub` PMH ID (CẤM khóa theo email, AD-8)
-- Dùng chung cho 1.3 (sync danh bạ), 1.5 (vai), 1.6 (quyền per-user)
CREATE TABLE IF NOT EXISTS users (
  sub text PRIMARY KEY,
  email text,
  employee_code text,
  full_name text,
  groups jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'active',
  role text NOT NULL DEFAULT 'member',
  first_login_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

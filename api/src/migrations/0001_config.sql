-- FR-44: bảng tham số hệ thống + seed giá trị mặc định (story 1.1)
-- Màn hình SA chỉnh sửa là story 6.3; mọi module đọc qua SystemConfigService.
CREATE TABLE IF NOT EXISTS config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO config (key, value) VALUES
  ('booking_window_days', '30'),
  ('active_ticket_quota', '2'),
  ('extension_days_per_grant', '2'),
  ('extension_max_grants', '3'),
  ('license_warning_days', '30'),
  ('working_hours', '{"tz": "Asia/Ho_Chi_Minh", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "17:00"}'),
  ('approval_reminder_working_hours', '4')
ON CONFLICT (key) DO NOTHING;

-- Story 5.2: marker "1 mail/ngày" cho nhắc duyệt request treo (FR-24).
-- Ngày VN đã nhắc gần nhất (NULL = chưa nhắc). Sweep set = today_vn có điều kiện `< today_vn`
-- trong cùng tx với enqueue → job chạy đúp không mail đúp; sang ngày VN mới thì nhắc lại.
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS approval_reminder_date date;

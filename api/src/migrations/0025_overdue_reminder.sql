-- Story 5.3: marker "1 mail/ngày" cho nhắc quá hạn (FR-25). Ngày VN đã nhắc gần nhất
-- (NULL = chưa). Sweep set = today_vn có điều kiện `< today_vn` cùng tx enqueue → job chạy
-- đúp không mail đúp; sang ngày VN mới thì nhắc lại đến khi ticket close.
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS overdue_reminder_date date;

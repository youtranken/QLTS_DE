-- Đợt 2 (audit 2026-07-16 H2/H3): sửa drift tham số nghiệp vụ.
-- KHÔNG sửa 0001 (migration đã apply — sửa nội dung sẽ lệch checksum, runner fail).
-- H3 — giờ làm THẬT do doanh nghiệp chốt: 07:00–18:00, T2–T7 (days 1..6).
--      Seed 0001 cũ (08:00–17:00, T2–T6) lệch thực tế + FE hardcode.
UPDATE config
SET value = '{"tz": "Asia/Ho_Chi_Minh", "days": [1, 2, 3, 4, 5, 6], "start": "07:00", "end": "18:00"}'::jsonb,
    updated_at = now()
WHERE key = 'working_hours';

-- H2 — ngưỡng auto-duyệt (giờ) đưa vào config để SA chỉnh; trước đây là hằng số cứng
--      lặp ở FE (booking-types.ts) + BE (ticket-states.ts), SA không đổi được.
INSERT INTO config (key, value) VALUES ('auto_approve_max_hours', '48')
ON CONFLICT (key) DO NOTHING;

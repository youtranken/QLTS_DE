-- Audit 2026-07-19 (H-2): trần thời lượng một lượt mượn.
-- Trước đây parseBookingWindow CHỈ ràng `from` (window 30 ngày), không ràng `to` →
-- một request `to=+10 năm` giữ chỗ EXCLUDE suốt period; nếu Admin lỡ DUYỆT thì
-- autoCloseNoShow (chạy khi upper(period)<now) không bao giờ tới, sweep bỏ qua
-- 'pending', member không hủy được sau giờ nhận → máy giam vĩnh viễn, phải sửa DB tay.
-- Chốt nghiệp vụ: tối đa 90 ngày = 2160 giờ (mượn dài hạn `can_long_term`).
-- Độc lập với booking_window_days=30: window ràng GIỜ NHẬN nằm trong 30 ngày tới,
-- trần này ràng ĐỘ DÀI lượt mượn — nhận trong 30 ngày, mượn tối đa 90 ngày.
INSERT INTO config (key, value) VALUES ('max_booking_duration_hours', '2160')
ON CONFLICT (key) DO NOTHING;

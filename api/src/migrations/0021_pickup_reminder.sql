-- Story 3.9: marker nhắc xác nhận giao — MỘT LẦN/booking (party phiên 7, FR-26).
-- Trên DÒNG BOOKING (không phải ticket) → chuỗi định kỳ mỗi buổi nhắc riêng.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS pickup_reminder_at timestamptz;

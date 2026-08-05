-- Mail "tới hạn trả" (đúng ngày + giờ hết hạn buổi mượn) gửi MỘT LẦN. Marker cấp BOOKING
-- vì mỗi buổi (kể cả chuỗi định kỳ) có hạn trả riêng = upper(period). NULL = chưa gửi.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS due_notified_at timestamptz;

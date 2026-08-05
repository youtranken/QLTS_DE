-- Thời điểm giao/trả THEO TỪNG BUỔI cho chuỗi định kỳ (FL-3). Trước đây chỉ ticket cha có
-- delivered_at/returned_at, nên tab "Mượn-trả" của máy hiện state cha + timestamp NULL cho
-- MỌI buổi. Ghi mốc trên booking để mỗi buổi có mốc giao/trả riêng (buổi thường vẫn dùng
-- mốc trên ticket qua fallback ở read-model). Không backfill: buổi cũ để NULL.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS returned_at timestamptz;

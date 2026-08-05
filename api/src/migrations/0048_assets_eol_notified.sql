-- Đánh dấu máy đã được đưa vào digest cảnh báo EOL (đủ tuổi thọ → cần thanh lý).
-- NULL = chưa từng báo; có mốc = đã báo. Digest chỉ phát khi có máy MỚI (cột này NULL),
-- để máy đã báo mà chưa thanh lý (còn "treo") không bị nhắc lại mỗi tuần.
ALTER TABLE assets ADD COLUMN eol_notified_at timestamptz;

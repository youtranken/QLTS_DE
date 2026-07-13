-- Ngày dự kiến xong khi Khóa sửa chữa (ETA). Sweep auto-unlock đọc cột này để tự mở khóa
-- máy pool khi tới ngày → máy quay lại mượn được (thay vì phải mở tay).
ALTER TABLE assets ADD COLUMN IF NOT EXISTS lock_eta date;

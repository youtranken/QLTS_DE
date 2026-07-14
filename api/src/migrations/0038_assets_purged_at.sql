-- Soft-purge Kho thanh lý: máy đã thanh lý "không còn dùng" → set purged_at để ẨN khỏi
-- MỌI danh sách (coi như đã xóa), NHƯNG giữ nguyên row + allocation_history (append-only,
-- AD-10) + audit. Không hard-delete được vì FK NOT NULL + trigger append-only.
ALTER TABLE assets ADD COLUMN purged_at timestamptz;

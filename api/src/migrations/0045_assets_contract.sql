-- Thêm cột 'contract' (số hợp đồng mua) vào assets — tách riêng khỏi 'note'. Chủ yếu dùng cho
-- license phần mềm (mỗi bản/seat có số hợp đồng riêng), nhưng để chung trên assets như note.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS contract text;

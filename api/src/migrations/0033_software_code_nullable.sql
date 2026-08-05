-- Story sw-license-model-redesign: phần mềm định danh bằng license_name, KHÔNG cần mã tài sản.
-- Nới `code` cho NULL (software không cần), nhưng CHECK giữ MÁY (non-software) vẫn bắt buộc code.
ALTER TABLE assets ALTER COLUMN code DROP NOT NULL;

ALTER TABLE assets
  ADD CONSTRAINT assets_code_required_nonsoftware
  CHECK (type = 'software' OR code IS NOT NULL);

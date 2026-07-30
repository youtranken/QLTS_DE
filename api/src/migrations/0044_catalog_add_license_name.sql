-- Thêm kind 'licenseName' vào danh mục (Tên license phần mềm = cột assets.license_name).
-- Cho dropdown chọn nhanh Tên license trong form Thêm phần mềm (như Configuration/Place) +
-- quản lý (đổi tên cascade / ẩn-hiện) ở trang Danh mục. Đổi tên 1 license ở danh mục sẽ
-- cascade sang MỌI bản (seat) cùng tên (catalog.service rename → UPDATE assets.license_name).
ALTER TABLE catalog DROP CONSTRAINT IF EXISTS catalog_kind_check;
ALTER TABLE catalog
  ADD CONSTRAINT catalog_kind_check
  CHECK (kind IN ('type', 'brand', 'configuration', 'place', 'licenseName'));

-- Seed từ tên license đang có trong sổ (chỉ phần mềm) → dropdown có sẵn lựa chọn.
INSERT INTO catalog (kind, value)
SELECT DISTINCT 'licenseName', license_name
FROM assets
WHERE type = 'software'
  AND license_name IS NOT NULL
  AND btrim(license_name) <> ''
ON CONFLICT (kind, value) DO NOTHING;

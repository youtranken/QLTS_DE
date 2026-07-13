-- Thêm kind 'place' vào danh mục (Place = vị trí đặt máy = cột assets.floor, hồi sinh sau 7.6).
-- Cho phép dropdown Place trong form Thêm/Sửa tài sản như Configuration/Asset Type.
ALTER TABLE catalog DROP CONSTRAINT IF EXISTS catalog_kind_check;
ALTER TABLE catalog
  ADD CONSTRAINT catalog_kind_check
  CHECK (kind IN ('type', 'brand', 'configuration', 'place'));

-- Seed Place từ các giá trị floor đang có trong sổ tài sản → dropdown có sẵn lựa chọn.
INSERT INTO catalog (kind, value)
SELECT DISTINCT 'place', floor
FROM assets
WHERE floor IS NOT NULL AND btrim(floor) <> ''
ON CONFLICT (kind, value) DO NOTHING;

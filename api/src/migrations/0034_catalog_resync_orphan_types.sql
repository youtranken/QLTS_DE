-- A1 (UAT 2026-07-12): tái đồng bộ catalog với giá trị đang có trên assets — chữa "giá trị mồ côi".
-- 0031 chỉ seed tại thời điểm chạy; loại/hãng/cấu hình thêm SAU đó (import/tay) không vào danh mục
-- (vd type 'PC' trên FAKE-0002) → form không tạo được + dữ liệu lệch danh mục. Idempotent (ON CONFLICT).
INSERT INTO catalog (kind, value)
SELECT 'type', type FROM assets
WHERE type IS NOT NULL AND btrim(type) <> ''
GROUP BY type
ON CONFLICT (kind, value) DO NOTHING;

INSERT INTO catalog (kind, value)
SELECT 'brand', brand FROM assets
WHERE brand IS NOT NULL AND btrim(brand) <> ''
GROUP BY brand
ON CONFLICT (kind, value) DO NOTHING;

INSERT INTO catalog (kind, value)
SELECT 'configuration', configuration FROM assets
WHERE configuration IS NOT NULL AND btrim(configuration) <> ''
GROUP BY configuration
ON CONFLICT (kind, value) DO NOTHING;

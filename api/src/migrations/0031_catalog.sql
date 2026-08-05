-- Story 8.1: danh mục Loại/Hãng/Cấu hình (catalog) — giá trị chuẩn cho form Thêm tài sản.
-- Asset vẫn lưu type/brand/configuration dạng text (không FK); catalog là "từ vựng có kiểm soát"
-- để dropdown chọn nhanh + gộp giá trị trùng. Unique (kind, value) exact — cho phép seed cả biến
-- thể hoa/thường đang tồn tại ('Laptop'/'laptop') để admin GỘP; create chặn trùng case-insensitive.
CREATE TABLE IF NOT EXISTS catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('type', 'brand', 'configuration')),
  value text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_kind_value_uq ON catalog (kind, value);

-- Seed từ giá trị đang có trên assets (distinct, bỏ rỗng). ON CONFLICT DO NOTHING → re-migrate
-- (test drop _migrations rồi chạy lại) idempotent, không vỡ unique. Software (type='software') vẫn
-- là 'Loại' hợp lệ nên vẫn seed để danh mục phản ánh đúng dữ liệu.
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

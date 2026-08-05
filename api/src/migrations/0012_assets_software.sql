-- Story 2.4: software là bản ghi asset riêng gắn 0..1 máy (FR-37/38, AD-7)
-- CHECK tầng DB = chốt cuối cho mọi đường vòng (kể cả import 2.9)
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS license_type text,
  ADD COLUMN IF NOT EXISTS license_name text,
  ADD COLUMN IF NOT EXISTS installed_on_asset_id uuid REFERENCES assets(id);

-- Cách ly dữ liệu legacy (review 2.4): row 'software' gõ tay từ 2.1-2.3 không có
-- license sẽ làm ADD CONSTRAINT fail toàn bộ → API không boot. Đổi nhãn để Admin
-- rà lại bằng filter loại 'software-legacy' rồi tạo bản ghi software chuẩn.
UPDATE assets SET type = 'software-legacy'
WHERE type = 'software' AND license_type IS NULL;

ALTER TABLE assets
  ADD CONSTRAINT assets_license_type_check
    CHECK (license_type IN ('term', 'perpetual')),
  -- non-software không có trường software
  ADD CONSTRAINT assets_software_fields_check
    CHECK (
      type = 'software'
      OR (license_type IS NULL AND license_name IS NULL AND installed_on_asset_id IS NULL)
    ),
  -- software bắt buộc có loại license (FR-38)
  ADD CONSTRAINT assets_software_license_required
    CHECK (type <> 'software' OR license_type IS NOT NULL),
  -- software KHÔNG bật pool (không cho mượn riêng — FR-37)
  ADD CONSTRAINT assets_software_no_pool_check
    CHECK (type <> 'software' OR is_pool = false),
  -- term → bắt buộc hạn; perpetual → bắt buộc tên + KHÔNG có hạn (FR-38)
  ADD CONSTRAINT assets_license_term_check
    CHECK (license_type <> 'term' OR end_date IS NOT NULL),
  ADD CONSTRAINT assets_license_perpetual_check
    CHECK (
      license_type <> 'perpetual'
      OR (license_name IS NOT NULL AND end_date IS NULL)
    );

CREATE INDEX IF NOT EXISTS idx_assets_installed_on ON assets (installed_on_asset_id);

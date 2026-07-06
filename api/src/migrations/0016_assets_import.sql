-- Story 2.9: import Excel go-live — chuỗi USER GỐC lưu vĩnh viễn (FR-40),
-- cờ cần đối chiếu cho nút "Đối chiếu lại" (FR-4)
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS imported_user_text text,
  ADD COLUMN IF NOT EXISTS needs_user_match boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_assets_needs_user_match
  ON assets (needs_user_match) WHERE needs_user_match;

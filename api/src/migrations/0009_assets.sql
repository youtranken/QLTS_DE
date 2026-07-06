-- Story 2.1: bảng assets — sổ tài sản thay Excel (~3.000 dòng)
-- UNIQUE(code) ở TẦNG DB = chốt cuối chống trùng mã cho cả import 2.9 chạy song song
-- status CHECK cố định từ đây — 2.6 chỉ thêm nghiệp vụ chuyển trạng thái, không đổi schema
CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  type text NOT NULL,
  configuration text,
  cost bigint,
  start_date date,
  end_date date,
  floor text,
  status text NOT NULL DEFAULT 'in_use'
    CHECK (status IN ('in_use', 'locked_repair', 'disposed')),
  note text,
  serial text,
  brand text,
  model text,
  -- người đứng tên: FK users(sub) — sync 1.3 chỉ upsert, không bao giờ xóa user
  assigned_user_sub text REFERENCES users(sub),
  is_pool boolean NOT NULL DEFAULT false,
  -- optimistic lock (FR-49, AD-4)
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index các cột lọc/tìm (AC 2): mã đã có UNIQUE index; còn lại tạo ở đây
CREATE INDEX IF NOT EXISTS idx_assets_assigned_user ON assets (assigned_user_sub);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets (type);
CREATE INDEX IF NOT EXISTS idx_assets_floor ON assets (floor);

-- Story 7.1: danh mục Phòng ban (QLTS tự quản, KHÔNG lấy từ SSO group).
-- Dùng cho luồng cho mượn (booking.department_id thêm ở 7.2). Soft-disable qua `active`,
-- KHÔNG xóa cứng — giữ toàn vẹn tham chiếu booking lịch sử.
CREATE TABLE IF NOT EXISTS department (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Tên duy nhất case-insensitive ở TẦNG DB (chống TOCTOU 2 request cùng tên) — AC1.
CREATE UNIQUE INDEX IF NOT EXISTS department_name_lower_uidx ON department (lower(name));

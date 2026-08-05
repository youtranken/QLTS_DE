-- Gỡ Epic 7.1 (departments — QLTS tự quản). Đơn vị tổ chức chuyển sang SSO group. Giữ booking.note (7.2).
ALTER TABLE booking DROP COLUMN IF EXISTS department_id;
DROP TABLE IF EXISTS department;

-- Phòng ban từ PMH-ID (claim `department`, đọc lúc login + directory-sync). Hiện ở /admin.
-- NULL nếu IDP chưa gửi. Không FK — chỉ chuỗi tên phòng ban do IDP quản.
ALTER TABLE users ADD COLUMN IF NOT EXISTS department text;

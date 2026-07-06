-- Review 1.5: SA CHỈ từ env — bảng users không bao giờ chứa role 'sa'
-- (chặn đường ghi DB trực tiếp/bug tương lai tự phong SA)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('member', 'admin'));

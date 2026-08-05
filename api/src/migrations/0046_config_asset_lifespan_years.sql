-- Cảnh báo EOL (End of Life): tuổi thọ máy mặc định 8 năm → cảnh báo thanh lý.
-- Ngưỡng SA chỉnh ở trang Cấu hình (song song license_warning_days). Đơn vị: NĂM.
INSERT INTO config (key, value) VALUES ('asset_lifespan_years', '8')
ON CONFLICT (key) DO NOTHING;

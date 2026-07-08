-- Lưu id_token lúc login để dùng làm `id_token_hint` khi RP-initiated logout (bai-hoc-sso #5/#6):
-- thiếu hint → PMH ID không nhận diện được phiên → trang lỗi khi đã logout. Phiên cũ id_token NULL
-- vẫn logout được (chỉ mất đường tối ưu, rơi về xác nhận).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id_token text;

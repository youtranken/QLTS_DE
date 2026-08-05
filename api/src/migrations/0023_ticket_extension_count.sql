-- Story 4.1: đếm số lần gia hạn đã dùng của ticket (FR-18 — tối đa `extension_max_grants`).
-- Trên TICKET (không phải booking) — chuỗi định kỳ không gia hạn buổi lẻ (FR-48).
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS extension_count int NOT NULL DEFAULT 0;

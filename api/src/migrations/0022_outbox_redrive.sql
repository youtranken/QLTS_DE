-- Review Epic 3 (F1/F2): outbox re-drive + DLQ marker bền.
-- F1: relay CŨ claim theo `claimed_at IS NULL` và set claimed_at ngay sau khi đẩy vào BullMQ
--     → row nào job cạn retry (DLQ) hoặc Redis mất job thì kẹt claimed≠NULL, processed=NULL
--     và KHÔNG BAO GIỜ được relay lại = nuốt event (vi phạm AD-11). Sửa: relay claim theo
--     `processed_at IS NULL` + lease (claimed_at là mốc thuê, hết 5' thì re-drive). Consumer
--     (baseline worker/Epic 5) check-and-set processed_at khi xử xong → không re-drive vô hạn.
-- F2: cột đếm/ghi lỗi để job cạn retry hiện lên dashboard SA (không chết im lặng, AD-9).

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS fail_count int NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;

-- Index hàng đợi relay MỚI: event CHƯA xử (processed_at IS NULL), cũ trước. Thay index cũ
-- (chỉ theo claimed_at) vì điều kiện claim giờ dựa processed_at + lease.
DROP INDEX IF EXISTS idx_outbox_unclaimed;
CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed
  ON outbox (created_at) WHERE processed_at IS NULL;

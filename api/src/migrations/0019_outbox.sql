-- Story 3.5a: outbox — sự kiện nghiệp vụ ghi CÙNG transaction (AD-11), relay sang BullMQ.
-- Redis chết vẫn không mất nghiệp vụ: event nằm trong Postgres tới khi relay claim được.
-- payload CHỈ id tham chiếu (không PII) — worker tự đọc lại từ DB.
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- relay đã đẩy vào BullMQ (jobId = id → dedup CỬA SỔ ở tầng queue)
  claimed_at timestamptz,
  -- Dedup BỀN (AD-11 at-least-once): consumer Epic 5 check-and-set
  -- `UPDATE outbox SET processed_at=now() WHERE id=$1 AND processed_at IS NULL RETURNING id`
  -- → 0 dòng = đã xử → bỏ qua. Chống at-least-twice khi job bị GC + relay re-add. NULL ở 3.5a.
  processed_at timestamptz
);

-- Hàng đợi relay: event chưa claim, cũ trước. Partial index nhỏ (chỉ backlog).
CREATE INDEX IF NOT EXISTS idx_outbox_unclaimed
  ON outbox (created_at) WHERE claimed_at IS NULL;

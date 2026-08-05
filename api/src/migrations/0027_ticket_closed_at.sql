-- 6.1: marker bất biến thời điểm close ticket (báo cáo mượn/quá hạn theo kỳ).
-- Ghi MỘT LẦN qua COALESCE ở mọi transition đặt state='closed' (return, no_show, cha định kỳ).
-- Ticket close TRƯỚC migration này không backfill → báo cáo chỉ tính ticket có closed_at.
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- Bucket kỳ/tháng theo closed_at, cắt nửa đêm Asia/Ho_Chi_Minh (AC3).
CREATE INDEX IF NOT EXISTS ticket_closed_at_idx ON ticket (closed_at) WHERE closed_at IS NOT NULL;

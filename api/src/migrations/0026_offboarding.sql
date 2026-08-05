-- Story 5.5: cảnh báo nghỉ việc + sync định kỳ.
-- Marker per-user chống mail cảnh báo đúp (webhook ‖ polling cùng service scan); reset khi
-- user mở khóa về active để lần disable sau còn cảnh báo (AC4 tự-tắt).
ALTER TABLE users ADD COLUMN IF NOT EXISTS offboard_alerted_at timestamptz;

-- Idempotent webhook theo event_id (retry/replay không chạy 2 lần — AC2).
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Lịch sync định kỳ (config được — AC1). Marker last-run ghi runtime vào config.
INSERT INTO config (key, value)
VALUES ('directory_sync_interval_minutes', to_jsonb(60))
ON CONFLICT (key) DO NOTHING;

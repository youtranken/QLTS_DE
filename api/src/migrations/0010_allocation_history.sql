-- Story 2.3: lịch sử cấp phát A→B (FR-35) — append-only từ phía app (không có
-- endpoint UPDATE/DELETE); actor là text vì 2.9 sẽ ghi 'import go-live'
CREATE TABLE IF NOT EXISTS allocation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id),
  -- from NULL = cấp lần đầu; to NULL = thu hồi về kho
  from_user_sub text REFERENCES users(sub),
  to_user_sub text REFERENCES users(sub),
  note text,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_allocation_history_asset
  ON allocation_history (asset_id, created_at DESC);

-- Story 2.6: lịch sử note tình trạng máy (FR-33/34) — lý do khóa + ETA;
-- Epic 3 thêm kind 'handover' (note giao-nhận); 2.7 hiển thị tab
CREATE TABLE IF NOT EXISTS asset_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id),
  kind text NOT NULL CHECK (kind IN ('lock', 'unlock', 'dispose', 'handover')),
  note text,
  eta date,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_note_asset
  ON asset_note (asset_id, created_at DESC);

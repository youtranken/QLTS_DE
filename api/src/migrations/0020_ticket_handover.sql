-- Story 3.6: giao-nhận máy. delivered_at/returned_at cho tab "Mượn-trả" (FR-34);
-- ticket_file link ảnh giao-nhận vào ticket (kiểm quyền khi xem — AD-6/NFR-8).
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS returned_at timestamptz;

CREATE TABLE IF NOT EXISTS ticket_file (
  ticket_id uuid NOT NULL REFERENCES ticket(id),
  file_id uuid NOT NULL REFERENCES files(id),
  -- 'deliver' = ảnh lúc giao (tình trạng đầu), 'return' = ảnh lúc nhận
  phase text NOT NULL CHECK (phase IN ('deliver', 'return')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_file_ticket ON ticket_file (ticket_id);

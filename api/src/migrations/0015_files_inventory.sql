-- Story 2.8: module file dùng chung (AD-6) + đợt kiểm kê hằng năm (FR-39)
-- File lưu trên volume với tên = id (uuid không đoán được); KHÔNG có static public
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name text NOT NULL,
  mime text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'document')),
  size_bytes integer NOT NULL,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_rounds_year
  ON inventory_rounds (year DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS inventory_round_files (
  round_id uuid NOT NULL REFERENCES inventory_rounds(id),
  file_id uuid NOT NULL REFERENCES files(id),
  PRIMARY KEY (round_id, file_id)
);

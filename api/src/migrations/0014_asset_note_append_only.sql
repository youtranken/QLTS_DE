-- Review 2.6: asset_note là sổ vết (FR-34 — lịch sử tình trạng máy) — enforce
-- append-only ở TẦNG DB theo tiền lệ 0005/0011, không tin logic app
CREATE OR REPLACE FUNCTION forbid_asset_note_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'asset_note is append-only (FR-34) — không được %', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS asset_note_append_only ON asset_note;
CREATE TRIGGER asset_note_append_only
  BEFORE UPDATE OR DELETE ON asset_note
  FOR EACH ROW EXECUTE FUNCTION forbid_asset_note_mutation();

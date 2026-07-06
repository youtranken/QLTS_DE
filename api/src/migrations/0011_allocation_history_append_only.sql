-- Review 2.3: allocation_history cùng bản chất sổ vết (FR-35) — enforce
-- append-only ở TẦNG DB như audit_log (tiền lệ 0005/AD-10), không tin logic app
CREATE OR REPLACE FUNCTION forbid_allocation_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'allocation_history is append-only (FR-35) — không được %', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS allocation_history_append_only ON allocation_history;
CREATE TRIGGER allocation_history_append_only
  BEFORE UPDATE OR DELETE ON allocation_history
  FOR EACH ROW EXECUTE FUNCTION forbid_allocation_history_mutation();

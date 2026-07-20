-- Audit 2026-07-19 (F11): 0011/0014 chỉ có trigger FOR EACH ROW trên UPDATE/DELETE.
-- Postgres KHÔNG kích hoạt trigger FOR EACH ROW khi TRUNCATE → hai bảng sổ-vết này
-- truncate được, trong khi audit_log đã được bịt từ 0006. Bù theo đúng mẫu 0006.

DROP TRIGGER IF EXISTS allocation_history_no_truncate ON allocation_history;
CREATE TRIGGER allocation_history_no_truncate
  BEFORE TRUNCATE ON allocation_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_allocation_history_mutation();

DROP TRIGGER IF EXISTS asset_note_no_truncate ON asset_note;
CREATE TRIGGER asset_note_no_truncate
  BEFORE TRUNCATE ON asset_note
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_asset_note_mutation();

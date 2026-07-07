-- Story 3.1a: bookability ép ở TẦNG DB (AD-15) — INSERT booking lên máy khóa/ngoài pool bị từ chối.
-- FOR SHARE là điểm mấu chốt: serialize với UPDATE assets (khóa/gỡ pool/thanh lý) —
-- đóng race "trigger đọc status cũ trong lúc cascade của transaction khóa máy đã chạy xong".
-- Lỗi mang prefix 'ASSET_UNAVAILABLE' (errcode P0001) — exception mapper dịch 409 ở 3.1c.
CREATE OR REPLACE FUNCTION booking_check_bookable() RETURNS trigger AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT status, is_pool INTO a FROM assets WHERE id = NEW.asset_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSET_UNAVAILABLE: asset % không tồn tại', NEW.asset_id;
  END IF;
  IF a.status <> 'in_use' OR a.is_pool = false THEN
    RAISE EXCEPTION 'ASSET_UNAVAILABLE: asset % không cho mượn (status=%, is_pool=%)',
      NEW.asset_id, a.status, a.is_pool;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- INSERT hoặc UPDATE làm booking (sẽ) CHIẾM CHỖ mới bị kiểm (F1 review):
--  - INSERT non-occupying (vd nạp lịch sử 'cancelled'/'returned') → thả, không chặn.
--  - UPDATE 'cancelled' → 'held'/đổi asset_id/kéo dài period sang máy khóa → occupying → kiểm.
--  - Hủy booking trên máy đang khóa (đổi state → 'cancelled') → non-occupying → thả (đúng:
--    phải hủy được booking trên máy vừa khóa). WHEN eval trên NEW nên đọc trạng thái đích.
-- EXCLUDE tự re-check chồng giờ khi UPDATE state/period/asset_id; bookability thì KHÔNG có gì
-- re-check nếu chỉ BEFORE INSERT → phải phủ cả UPDATE.
DROP TRIGGER IF EXISTS trg_booking_bookability ON booking;
CREATE TRIGGER trg_booking_bookability
  BEFORE INSERT OR UPDATE OF asset_id, state, period ON booking
  FOR EACH ROW
  WHEN (booking_state_occupies(NEW.state))
  EXECUTE FUNCTION booking_check_bookable();

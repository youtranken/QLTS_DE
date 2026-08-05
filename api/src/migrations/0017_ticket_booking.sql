-- Story 3.1a: ticket + booking — chống double-booking ở TẦNG DB (AD-2/AD-3/AD-12/AD-16)
-- Bound convention toàn hệ: period tstzrange [) — điểm nối không tự chồng (AD-2).
-- is_overdue là CỜ + overdue_marked_at là MARKER bất biến, không phải state (AD-14).

CREATE TABLE IF NOT EXISTS ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'recurring' = ticket cha chuỗi định kỳ (Epic 4); state cha là STORED (AD-4)
  kind text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'recurring')),
  state text NOT NULL CHECK (
    state IN ('pending_approval', 'awaiting_pickup', 'in_use', 'closed', 'rejected', 'cancelled')
  ),
  -- close_reason chỉ có nghĩa khi đã đóng; reject_reason chỉ khi từ chối (AD-16).
  -- CHECK per-row đánh giá lại trên MỌI update → không lách được bằng đổi state sau.
  close_reason text CHECK (close_reason IS NULL OR state = 'closed'),
  reject_reason text CHECK (reject_reason IS NULL OR state = 'rejected'),
  borrower_sub text NOT NULL REFERENCES users(sub),
  created_by_sub text NOT NULL REFERENCES users(sub),
  is_overdue boolean NOT NULL DEFAULT false,
  overdue_marked_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_borrower ON ticket (borrower_sub);
CREATE INDEX IF NOT EXISTS idx_ticket_state ON ticket (state);

-- OCCUPYING_STATES (AD-2) = {held, pending, delivered}.
-- Function dùng cho: (1) trigger WHEN (live eval — CREATE OR REPLACE an toàn), (2) test
-- khẳng định khớp bản TS (ticket-states.ts). EXCLUDE + partial index KHÔNG gọi function mà
-- INLINE literal — vì đổi function bằng CREATE OR REPLACE KHÔNG rebuild index đang tham chiếu
-- → constraint "nói dối" im lặng (F3 review). Inline = muốn đổi list phải DROP/ADD constraint
-- (revalidate cả bảng). 3 nguồn (function, inline predicate, TS const) BẮT BUỘC khớp —
-- booking.db-spec kiểm HÀNH VI cả 5 state để chốt, không tin mỗi function.
CREATE OR REPLACE FUNCTION booking_state_occupies(s text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN s IN ('held', 'pending', 'delivered');

CREATE TABLE IF NOT EXISTS booking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  kind text NOT NULL CHECK (kind IN ('normal', 'recurring', 'extension')),
  state text NOT NULL CHECK (state IN ('held', 'pending', 'delivered', 'returned', 'cancelled')),
  -- Bound [) ép ở DB (AD-2, F6 review): tstzrange KHÔNG canonicalize → không chốt bound thì
  -- '[]'/'(]' hoặc biên vô hạn lọt CHECK và phá "điểm nối không tự chồng". Ép: không rỗng
  -- + đóng đầu + mở cuối + hai biên hữu hạn.
  period tstzrange NOT NULL CHECK (
    NOT isempty(period)
    AND lower_inc(period) AND NOT upper_inc(period)
    AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL
  ),
  -- kết cục dòng gia hạn khi cancelled (AD-3, Epic 4 dùng — khai từ đầu tránh ALTER)
  result text CHECK (result IN ('approved', 'rejected', 'expired')),
  is_overdue boolean NOT NULL DEFAULT false,
  overdue_marked_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_result_extension_only CHECK (result IS NULL OR kind = 'extension'),
  -- LÕI AD-2: hai booking CHIẾM CHỖ cùng máy không bao giờ chồng giờ — bất kể app viết gì.
  CONSTRAINT booking_no_overlap EXCLUDE USING GIST (asset_id WITH =, period WITH &&)
    WHERE (state IN ('held', 'pending', 'delivered'))
);

CREATE INDEX IF NOT EXISTS idx_booking_ticket ON booking (ticket_id);
-- Partial index cho câu hỏi nóng "máy X còn slot nào" — cùng predicate INLINE với EXCLUDE
CREATE INDEX IF NOT EXISTS idx_booking_asset_occupying
  ON booking (asset_id) WHERE state IN ('held', 'pending', 'delivered');

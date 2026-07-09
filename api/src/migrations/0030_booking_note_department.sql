-- Story 7.2: ghi chú lượt mượn + phòng ban trên booking.
-- department_id FK → department(id) (7.1). KHÔNG cascade: department soft-disable (không DELETE),
-- booking giữ department_id lịch sử — board (7.4) join theo id, không lọc active.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES department(id);

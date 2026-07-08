import { elapsedWorkingMinutes, vnDateString } from './working-hours';
import type { WorkingHours } from '../config/system-config.service';

const WH: WorkingHours = {
  tz: 'Asia/Ho_Chi_Minh',
  days: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '17:00',
};
// Neo tuần cố định: 2026-07-06 = T2, 07-10 = T6, 07-11 = T7, 07-13 = T2 (VN).
const vn = (iso: string) => new Date(`${iso}+07:00`);

describe('elapsedWorkingMinutes (story 5.2)', () => {
  it('trong giờ làm việc cùng ngày → đếm đủ', () => {
    expect(
      elapsedWorkingMinutes(
        vn('2026-07-06T09:00:00'),
        vn('2026-07-06T11:00:00'),
        WH,
      ),
    ).toBe(120);
  });

  it('trước giờ làm → không đếm phần ngoài giờ', () => {
    expect(
      elapsedWorkingMinutes(
        vn('2026-07-06T06:00:00'),
        vn('2026-07-06T07:30:00'),
        WH,
      ),
    ).toBe(0);
  });

  it('cắt trần theo giờ tan làm (17:00)', () => {
    expect(
      elapsedWorkingMinutes(
        vn('2026-07-06T16:00:00'),
        vn('2026-07-06T18:30:00'),
        WH,
      ),
    ).toBe(60);
  });

  it('bắt đầu trước 8:00 → tính từ 8:00', () => {
    expect(
      elapsedWorkingMinutes(
        vn('2026-07-06T07:00:00'),
        vn('2026-07-06T09:00:00'),
        WH,
      ),
    ).toBe(60);
  });

  it('treo chiều thứ Sáu → bỏ cuối tuần, tiếp từ 8:00 thứ Hai (NFR-6)', () => {
    // T6 16:30→17:00 = 30' ; T7/CN = 0 ; T2 08:00→08:30 = 30'
    expect(
      elapsedWorkingMinutes(
        vn('2026-07-10T16:30:00'),
        vn('2026-07-13T08:30:00'),
        WH,
      ),
    ).toBe(60);
  });

  it('nhiều ngày làm việc liên tiếp → cộng dồn', () => {
    // T2 08:00 → T4 17:00 = 3 ngày × 9h = 1620'
    expect(
      elapsedWorkingMinutes(
        vn('2026-07-06T08:00:00'),
        vn('2026-07-08T17:00:00'),
        WH,
      ),
    ).toBe(1620);
  });

  it('to <= from → 0', () => {
    expect(
      elapsedWorkingMinutes(
        vn('2026-07-06T10:00:00'),
        vn('2026-07-06T10:00:00'),
        WH,
      ),
    ).toBe(0);
  });

  it('vnDateString trả ngày VN (cắt nửa đêm Asia/Ho_Chi_Minh)', () => {
    // 2026-07-06T23:30Z = 07-07 06:30 VN → ngày VN là 07-07
    expect(vnDateString(new Date('2026-07-06T23:30:00Z'))).toBe('2026-07-07');
  });
});

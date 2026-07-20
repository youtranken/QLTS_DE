import { BadRequestException } from '@nestjs/common';
import { assertBookingDuration, parseBookingWindow } from './booking-window';

/**
 * Audit 2026-07-19 (H-2): trần thời lượng một lượt mượn.
 * Trước bản vá, `to` không bị ràng gì — booking 10 năm lọt qua, giam máy.
 */
const NOW = Date.parse('2026-07-20T00:00:00.000Z');
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as BadRequestException).getResponse
      ? ((e as BadRequestException).getResponse() as { code: string }).code
      : 'THREW_NON_HTTP';
  }
  return 'NO_THROW';
};

describe('parseBookingWindow — trần thời lượng (audit H-2)', () => {
  const MAX = 2160; // 90 ngày

  it('đúng trần (90 ngày chẵn) → hợp lệ, không ném', () => {
    const res = parseBookingWindow(
      iso(HOUR),
      iso(HOUR + MAX * HOUR),
      30,
      NOW,
      MAX,
    );
    expect(res.to.getTime() - res.from.getTime()).toBe(MAX * HOUR);
  });

  it('vượt trần 1 giờ → BOOKING_TOO_LONG', () => {
    expect(
      codeOf(() =>
        parseBookingWindow(
          iso(HOUR),
          iso(HOUR + (MAX + 1) * HOUR),
          30,
          NOW,
          MAX,
        ),
      ),
    ).toBe('BOOKING_TOO_LONG');
  });

  it('booking 10 năm (kịch bản giam máy) → BOOKING_TOO_LONG', () => {
    expect(
      codeOf(() =>
        parseBookingWindow(iso(HOUR), iso(3650 * DAY), 30, NOW, MAX),
      ),
    ).toBe('BOOKING_TOO_LONG');
  });

  it('KHÔNG truyền maxDurationHours → giữ hành vi cũ (không áp trần)', () => {
    const res = parseBookingWindow(iso(HOUR), iso(3650 * DAY), 30, NOW);
    expect(res.to.getTime()).toBe(NOW + 3650 * DAY);
  });

  it('trần không lấn sân các mã lỗi cũ: giờ nhận quá window vẫn là BOOKING_WINDOW', () => {
    expect(
      codeOf(() =>
        parseBookingWindow(iso(31 * DAY), iso(32 * DAY), 30, NOW, MAX),
      ),
    ).toBe('BOOKING_WINDOW');
  });

  it('giờ trả trước giờ nhận vẫn là INVALID_RANGE, không phải TOO_LONG', () => {
    expect(
      codeOf(() => parseBookingWindow(iso(2 * DAY), iso(DAY), 30, NOW, MAX)),
    ).toBe('INVALID_RANGE');
  });
});

describe('assertBookingDuration — dùng chung cho giao-ngay và adminExtend', () => {
  it('maxHours undefined → bỏ qua (caller chưa truyền)', () => {
    expect(() =>
      assertBookingDuration(
        new Date(NOW),
        new Date(NOW + 3650 * DAY),
        undefined,
      ),
    ).not.toThrow();
  });

  it('vượt trần → ném BOOKING_TOO_LONG kèm số ngày dễ đọc', () => {
    try {
      assertBookingDuration(new Date(NOW), new Date(NOW + 91 * DAY), 2160);
      fail('phải ném');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as {
        code: string;
        message: string;
      };
      expect(body.code).toBe('BOOKING_TOO_LONG');
      expect(body.message).toContain('90 ngày');
    }
  });
});

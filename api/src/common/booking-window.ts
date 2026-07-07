import { BadRequestException } from '@nestjs/common';

export interface ParsedWindow {
  from: Date;
  to: Date;
}

/**
 * Validate khung giờ mượn (FR-9/44) dùng chung Booking (availability) + Tickets (submit):
 *  - parse được, to > from, from ≥ hiện tại, from trong booking window (windowDays).
 * Window CHỈ áp `from` (party phiên 7 — giờ trả lòi ra ngoài window vẫn hợp lệ).
 * So instant UTC (Date) — offset đã ép ở DTO nên timezone-independent.
 * Ném 400 phân biệt code: INVALID_RANGE / PAST_PICKUP / BOOKING_WINDOW.
 */
export function parseBookingWindow(
  fromIso: string,
  toIso: string,
  windowDays: number,
  now: number = Date.now(),
): ParsedWindow {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException({
      code: 'INVALID_RANGE',
      message: 'Giờ mượn/trả không hợp lệ.',
    });
  }
  if (to.getTime() <= from.getTime()) {
    throw new BadRequestException({
      code: 'INVALID_RANGE',
      message: 'Giờ trả phải sau giờ nhận.',
    });
  }
  if (from.getTime() < now) {
    throw new BadRequestException({
      code: 'PAST_PICKUP',
      message: 'Giờ nhận phải từ hiện tại trở đi.',
    });
  }
  if (from.getTime() > now + windowDays * 24 * 60 * 60 * 1000) {
    throw new BadRequestException({
      code: 'BOOKING_WINDOW',
      message: `Chỉ được đặt trong vòng ${windowDays} ngày tới.`,
    });
  }
  return { from, to };
}

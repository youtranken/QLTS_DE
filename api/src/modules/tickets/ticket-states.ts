/**
 * AD-16 — MỘT nguồn từ vựng trạng thái ticket × booking cho toàn hệ.
 * FE/Reports/mọi module import từ đây — KHÔNG tự định nghĩa lại.
 * `overdue` KHÔNG phải state — là cờ is_overdue + marker overdue_marked_at (AD-14).
 */

export const TICKET_STATES = [
  'pending_approval', // Chờ duyệt
  'awaiting_pickup', // Chờ giao
  'in_use', // Đang mượn
  'closed', // Đã đóng (kèm close_reason='no_show' cho auto no-show)
  'rejected', // Từ chối — KHÔNG gộp với Đã hủy
  'cancelled', // Đã hủy
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const BOOKING_STATES = [
  'held', // giữ chỗ chờ duyệt
  'pending', // đã duyệt, chờ giao
  'delivered', // đã giao
  'returned', // đã nhận lại
  'cancelled',
] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

export const BOOKING_KINDS = ['normal', 'recurring', 'extension'] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];

/**
 * AD-2 — trạng thái CHIẾM CHỖ (EXCLUDE chỉ áp cho các state này).
 * Nguồn tầng DB: function `booking_state_occupies` (migration 0017) —
 * booking.db-spec khẳng định 2 nguồn khớp nhau từng state.
 */
export const OCCUPYING_STATES = [
  'held',
  'pending',
  'delivered',
] as const satisfies readonly BookingState[];

export function isOccupying(state: BookingState): boolean {
  return (OCCUPYING_STATES as readonly string[]).includes(state);
}

/**
 * AD-4/FR-7 — "ticket active" (đếm quota): giữ chỗ/chờ giao/đang mượn.
 * MỘT nguồn — mọi chỗ đếm quota import đây, không tự liệt kê lại.
 * `rejected`/`cancelled`/`closed` KHÔNG đếm (đã rời hàng đợi).
 */
export const ACTIVE_TICKET_STATES = [
  'pending_approval',
  'awaiting_pickup',
  'in_use',
] as const satisfies readonly TicketState[];

// Ngưỡng tự-duyệt (FR-8) giờ lấy từ config `auto_approve_max_hours` (mặc định seed 48h,
// audit H2) — SystemConfigService.getAutoApproveMaxHours(). Không còn hằng số cứng ở BE.

/** Nhãn tiếng Việt theo bảng AD-16 — FE dùng làm nguồn cho i18n, không hard-code chuỗi trạng thái. */
export const TICKET_STATE_LABELS_VI: Record<TicketState, string> = {
  pending_approval: 'Chờ duyệt',
  awaiting_pickup: 'Chờ giao',
  in_use: 'Đang mượn',
  closed: 'Đã đóng',
  rejected: 'Từ chối',
  cancelled: 'Đã hủy',
};

/** Nhãn tiếng Việt cho TỪNG BUỔI của chuỗi định kỳ (booking.state) — 4.5b. */
export const BOOKING_SESSION_LABELS_VI: Record<BookingState, string> = {
  held: 'Chờ duyệt',
  pending: 'Chờ giao',
  delivered: 'Đang mượn',
  returned: 'Đã trả',
  cancelled: 'Đã hủy',
};

/** Bảng ánh xạ AD-16: ticket.state → booking.state tương ứng của luồng thuận. */
export const TICKET_TO_BOOKING_STATE: Record<TicketState, BookingState> = {
  pending_approval: 'held',
  awaiting_pickup: 'pending',
  in_use: 'delivered',
  closed: 'returned', // no-show: booking 'cancelled' — xử riêng theo close_reason (AD-16)
  rejected: 'cancelled',
  cancelled: 'cancelled',
};

/**
 * Hủy được: pending_approval bất kỳ lúc nào; awaiting_pickup CHỈ trước giờ nhận (FR-11).
 * `pickupPassed` derive từ DB now() (F5 — MỘT nguồn đồng hồ = Postgres, không trộn
 * Date.now() Node; đồng bộ với sweep expireStalePendingApprovals/autoCloseNoShow).
 */
export function isTicketCancellable(
  state: string,
  pickupPassed: boolean | null,
): boolean {
  if (state === 'pending_approval') return true;
  if (state === 'awaiting_pickup') return pickupPassed !== true;
  return false;
}

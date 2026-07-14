// Hằng số + helper ngày/giờ + kiểu dùng chung cho popup Đặt máy (booking-sheet và các
// mảnh tách ra: booking-time-fields, recurring-admin-builder). Gom một chỗ để không lệch.

export const MAX_DURATION_AUTO_MS = 48 * 60 * 60 * 1000;
// Khung giờ làm việc (9.8): chỉ cho đặt 07:00–18:00, T2–T7 (CN khóa). Giờ VN (UTC+7 cố định).
export const WORK_START = '07:00';
export const WORK_END = '18:00';
// #3: khung giờ nhận nhanh (chip) trong giờ làm việc. borrow-board dùng lại để tính "giờ trống"
// trên ĐÚNG các khung này — nhất quán giữa thẻ máy và popup.
export const PICKUP_SLOTS = ['08:00', '09:00', '10:00', '13:00', '14:00', '15:00'];

/** Ngày local (YYYY-MM-DD) theo tz máy — dùng cho default + min của input date. */
export const todayLocal = (): string => new Date().toLocaleDateString('en-CA');
/** HH:MM local hiện tại — chặn chọn giờ đã qua trong hôm nay. */
export const nowTimeLocal = (): string =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** true nếu chuỗi YYYY-MM-DD rơi vào Chủ nhật (local). */
export const isSunday = (d: string): boolean =>
  d ? new Date(`${d}T00:00`).getDay() === 0 : false;
/**
 * Ngày NHẬN mặc định khi mở popup: hôm nay nếu còn trong giờ làm; nếu đã quá 18:00
 * (hoặc Chủ nhật) thì nhảy sang ngày làm kế — tránh mở popup ngoài giờ mà ô Giờ nhận
 * hôm nay bị min>max không chọn được (user phải tự đổi ngày).
 */
export const nextBookableDate = (): string => {
  const d = new Date();
  if (nowTimeLocal() >= WORK_END) d.setDate(d.getDate() + 1); // hết giờ hôm nay → mai
  while (d.getDay() === 0) d.setDate(d.getDate() + 1); // bỏ qua Chủ nhật
  return d.toLocaleDateString('en-CA');
};

export interface FreeMachine {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
}
export interface UserOption {
  sub: string;
  fullName: string | null;
  email: string | null;
}
export type Mode = 'normal' | 'advanced' | 'recurring';
export interface SessionRow {
  from: string;
  to: string;
}

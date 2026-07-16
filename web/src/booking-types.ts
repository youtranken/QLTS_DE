// Hằng số + helper ngày/giờ + kiểu dùng chung cho popup Đặt máy (booking-sheet và các
// mảnh tách ra: booking-time-fields, recurring-admin-builder). Gom một chỗ để không lệch.

// Mặc định fallback khi chưa nạp config từ /me (audit H2/H3): 48h, 07:00–18:00, T2–T7 (ISO 1..6).
export const MAX_DURATION_AUTO_MS = 48 * 60 * 60 * 1000;
export const WORK_START = '07:00';
export const WORK_END = '18:00';
export interface WorkHoursCfg {
  days: number[]; // ISO 1=T2..7=CN
  start: string; // 'HH:MM'
  end: string;
}
export const DEFAULT_WORK_HOURS: WorkHoursCfg = {
  days: [1, 2, 3, 4, 5, 6],
  start: WORK_START,
  end: WORK_END,
};
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
/** ISO day (1=T2..7=CN) của chuỗi YYYY-MM-DD local. */
const isoDow = (d: string): number => {
  const g = new Date(`${d}T00:00`).getDay();
  return g === 0 ? 7 : g;
};
/** true nếu ngày KHÔNG thuộc ngày làm việc cấu hình (mặc định [1..6] → chỉ CN bị chặn). */
export const isBlockedDay = (d: string, days: number[]): boolean =>
  d ? !days.includes(isoDow(d)) : false;
/** true nếu chuỗi YYYY-MM-DD rơi vào Thứ 7 (6) hoặc Chủ nhật (0). */
export const isWeekend = (d: string): boolean => {
  if (!d) return false;
  const g = new Date(`${d}T00:00`).getDay();
  return g === 0 || g === 6;
};
/** Cộng n ngày lịch vào chuỗi YYYY-MM-DD (không đụng cuối tuần) — dùng cho cửa sổ ngày trả. */
export const addDays = (d: string, n: number): string => {
  const dt = new Date(`${d}T12:00:00`);
  dt.setDate(dt.getDate() + n);
  return dt.toLocaleDateString('en-CA');
};
/** Đẩy ngày (YYYY-MM-DD) ra khỏi cuối tuần → ngày làm kế (Thứ 2). */
export const nextWorkday = (d: string): string => {
  const dt = new Date(`${d}T12:00:00`);
  while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() + 1);
  return dt.toLocaleDateString('en-CA');
};
/**
 * Ngày NHẬN mặc định khi mở popup: hôm nay nếu còn trong giờ làm; nếu đã quá 18:00
 * (hoặc Chủ nhật) thì nhảy sang ngày làm kế — tránh mở popup ngoài giờ mà ô Giờ nhận
 * hôm nay bị min>max không chọn được (user phải tự đổi ngày).
 */
export const nextBookableDate = (wh: WorkHoursCfg = DEFAULT_WORK_HOURS): string => {
  const d = new Date();
  if (nowTimeLocal() >= wh.end) d.setDate(d.getDate() + 1); // hết giờ hôm nay → mai
  const dset = new Set(wh.days);
  const iso = (dt: Date) => (dt.getDay() === 0 ? 7 : dt.getDay());
  while (!dset.has(iso(d))) d.setDate(d.getDate() + 1); // bỏ qua ngày không làm việc
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

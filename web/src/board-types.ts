import { PICKUP_SLOTS } from './booking-sheet';

export interface BoardRow {
  ticketId: string;
  assetCode: string | null;
  type: string | null;
  borrowerName: string | null;
  from: string | null;
  due: string | null;
  state: string;
  isOverdue: boolean;
  isMine: boolean;
  note: string | null;
  recurringCount: number | null;
}

export interface FreePoolMachine {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
  // Phase 1b: null = rảnh ngay; else ISO giờ máy hết bận ("bận đến …").
  busyUntil?: string | null;
}

export interface CalBusy {
  from: string;
  to: string;
  kind: string;
}
export interface MachineCal {
  busy: CalBusy[];
}
export interface SlotInfo {
  /** 0 = hôm nay, 1 = ngày mai, … (-1 = kín cả tuần). */
  dayOffset: number;
  slots: string[];
}

export const POLL_MS = 30_000;
// #1: catalog "Máy có thể mượn" chỉ hiện tối đa 5 thẻ; còn lại bung qua "Xem tất cả".
export const CATALOG_CAP = 5;
// Gần tới giờ trả trong ngưỡng này → tô cam + chớp (cảnh báo sắp phải trả).
export const NEAR_DUE_MS = 2 * 60 * 60 * 1000;

/** Ngày dd/MM theo giờ VN (tách cột Ngày). */
export const dOnly = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleDateString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit',
        month: '2-digit',
      })
    : '—';
/** Giờ HH:MM theo giờ VN (tách cột Giờ). */
export const hOnly = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleTimeString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/**
 * Giờ trống của 1 máy ở NGÀY LÀM GẦN NHẤT còn khung rảnh — tính trên ĐÚNG 6 khung gợi ý
 * (PICKUP_SLOTS, nhất quán với popup Đặt): bỏ khung đã qua & khung đang bận. Buổi tối/CN
 * hôm nay hết → tự nhảy sang ngày làm kế. Lịch busy chỉ có trong tuần fetch (BE chốt khi Đặt).
 */
export function freeSlotsSoon(busy: CalBusy[]): SlotInfo {
  const now = Date.now();
  const ranges = busy.map(
    (b) => [new Date(b.from).getTime(), new Date(b.to).getTime()] as const,
  );
  for (let off = 0; off < 7; off++) {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    base.setDate(base.getDate() + off);
    if (base.getDay() === 0) continue; // CN nghỉ
    const out: string[] = [];
    for (const slot of PICKUP_SLOTS) {
      const [h, mm] = slot.split(':').map(Number);
      const t = new Date(base);
      t.setHours(h, mm, 0, 0);
      const ms = t.getTime();
      if (ms <= now) continue; // đã qua
      const busyAt = ranges.some(([bf, bt]) => bf <= ms && ms < bt);
      if (!busyAt) out.push(slot);
    }
    if (out.length > 0) return { dayOffset: off, slots: out };
  }
  return { dayOffset: -1, slots: [] };
}

import type { WorkingHours } from '../config/system-config.service';

/** Asia/Ho_Chi_Minh cố định UTC+7, KHÔNG có DST → dựng mốc bằng offset cố định, không cần tz lib. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' theo ngày VN của một mốc (en-CA cho định dạng ISO). */
export function vnDateString(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Số PHÚT làm việc giữa `from` và `to` — chỉ đếm trong khung [start,end] của các ngày
 * wh.days (ISO 1=T2..7=CN), giờ VN. Treo 16:30 thứ Sáu → phần còn lại của ngày + cuối tuần
 * KHÔNG đếm; tiếp tục từ 8:00 thứ Hai (NFR-6). Lặp theo ngày (request treo vài ngày → rẻ).
 */
export function elapsedWorkingMinutes(
  from: Date,
  to: Date,
  wh: WorkingHours,
): number {
  if (to.getTime() <= from.getTime()) return 0;
  const startMin = parseHm(wh.start);
  const endMin = parseHm(wh.end);
  const days = new Set(wh.days);

  // UTC instant của 0h VN ngày chứa `from`.
  const vnFrom = new Date(from.getTime() + VN_OFFSET_MS);
  const firstMidnightUtc =
    Date.UTC(
      vnFrom.getUTCFullYear(),
      vnFrom.getUTCMonth(),
      vnFrom.getUTCDate(),
    ) - VN_OFFSET_MS;

  let total = 0;
  for (let i = 0; i < 400; i++) {
    const midnightUtc = firstMidnightUtc + i * DAY_MS;
    if (midnightUtc > to.getTime()) break;
    const vnMid = new Date(midnightUtc + VN_OFFSET_MS);
    const jsDow = vnMid.getUTCDay(); // 0=CN..6=T7
    const isoDow = jsDow === 0 ? 7 : jsDow;
    if (!days.has(isoDow)) continue;
    const windowStart = midnightUtc + startMin * 60_000;
    const windowEnd = midnightUtc + endMin * 60_000;
    const lo = Math.max(from.getTime(), windowStart);
    const hi = Math.min(to.getTime(), windowEnd);
    if (hi > lo) total += (hi - lo) / 60_000;
  }
  return total;
}

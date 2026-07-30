import type { AssetFilter, GuidedAction } from './chatbot.types';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** Lọc tài sản từ args (guided params). */
export function toFilter(
  params: Record<string, unknown> | undefined,
): AssetFilter {
  const p = params ?? {};
  return {
    type: str(p.type),
    status: str(p.status),
    endFrom: str(p.endFrom),
    endTo: str(p.endTo),
    search: str(p.search),
  };
}

/** Tham số tìm máy trống; thiếu from/to → mặc định hôm nay 07:00–18:00 (+07:00) — G8. */
export function toAvailabilityParams(
  params: Record<string, unknown> | undefined,
): { from: string; to: string; type?: string } {
  const p = params ?? {};
  const from = str(p.from);
  const to = str(p.to);
  const type = str(p.type);
  if (from && to) return { from, to, type };
  const w = defaultWindow();
  return { from: w.from, to: w.to, type };
}

function defaultWindow(): { from: string; to: string } {
  const d = todayVn();
  return { from: `${d}T07:00:00+07:00`, to: `${d}T18:00:00+07:00` };
}

/** Ngày hôm nay theo TZ VN (YYYY-MM-DD) — dùng cho system prompt + cửa sổ mặc định. */
export function todayVn(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function mkDate(
  dd: string,
  mm: string,
  yy: string | undefined,
  curYear: number,
): string | undefined {
  const d = Number(dd);
  const mo = Number(mm);
  let y = yy ? Number(yy) : curYear;
  if (yy && yy.length === 2) y = 2000 + Number(yy);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/** Bắt ngày tiếng Việt trong câu → YYYY-MM-DD. Hỗ trợ hôm nay/mai/kia, d/m[/y], "ngày D tháng M". */
export function parseVnDate(text: string, today: string): string | undefined {
  const t = text.toLowerCase();
  if (/ngày kia|ngày mốt|\bmốt\b/.test(t)) return addDays(today, 2);
  if (/ngày mai|hôm sau|\bmai\b/.test(t)) return addDays(today, 1);
  if (/hôm nay|bây giờ|hiện tại/.test(t)) return today;
  const curYear = Number(today.slice(0, 4));
  let m = t.match(/ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?/);
  if (m) return mkDate(m[1], m[2], m[3], curYear);
  m = t.match(/(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?/);
  if (m) return mkDate(m[1], m[2], m[3], curYear);
  return undefined;
}

/** Bắt mã máy trong câu (MTS-123, 3-AA-CT-1444) — cần vừa có chữ vừa có số để tránh nhầm giờ/ngày. */
export function extractAssetCode(text: string): string | undefined {
  const m = text.match(/\b([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\b/);
  if (m && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])) return m[1].toUpperCase();
  const m2 = text.match(/\b([A-Za-z]{2,}\d{2,})\b/);
  if (m2) return m2[1].toUpperCase();
  return undefined;
}

/** Nhãn ngắn cho lượt guided (lưu lịch sử + tiêu đề cuộc). */
export function actionLabel(action: GuidedAction): string {
  const map: Record<string, string> = {
    menu: 'Mở đầu',
    list_types: 'Xem danh sách',
    list_result: 'Danh sách tài sản',
    my_assets: 'Máy của tôi',
    my_borrowings: 'Máy tôi đang mượn',
    availability: 'Tìm máy trống',
    day_availability: 'Khung giờ trống',
    get_asset: 'Chi tiết máy',
    asset_stats: 'Thống kê tài sản',
    software_info: 'Phần mềm / license',
    asset_history: 'Lịch sử cấp phát',
    pending_approvals: 'Hàng chờ duyệt',
    eol_alerts: 'Cảnh báo EOL',
    policy_hours: 'Giờ làm việc',
    policy_borrow: 'Quy định mượn',
    help: 'Trợ giúp',
  };
  return map[action.intent] ?? action.intent;
}

/** Câu mở đầu cho kết quả danh sách + "hiển thị N/tổng M" khi bị cắt (G4). */
export function listReply(
  total: number,
  shown: number,
  fromSearch = false,
): string {
  if (total === 0) {
    return fromSearch
      ? 'Mình chưa tìm thấy tài sản nào khớp. Bạn thử gõ mã máy/tên người, hoặc chọn nhanh ở thanh bên dưới nhé.'
      : 'Không có tài sản nào khớp bộ lọc này.';
  }
  const suffix =
    total > shown ? ` — hiển thị ${shown} đầu (tổng ${total})` : '';
  return `Tìm thấy ${total} tài sản${suffix}:`;
}

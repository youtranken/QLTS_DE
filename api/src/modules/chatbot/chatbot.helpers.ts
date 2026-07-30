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

/** Nhãn ngắn cho lượt guided (lưu lịch sử + tiêu đề cuộc). */
export function actionLabel(action: GuidedAction): string {
  const map: Record<string, string> = {
    menu: 'Mở đầu',
    list_types: 'Xem danh sách',
    list_result: 'Danh sách tài sản',
    my_assets: 'Máy của tôi',
    availability: 'Tìm máy trống',
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

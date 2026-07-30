/** Thẻ tài sản trả từ BE (khớp AssetCard của chatbot API). */
export interface Card {
  code: string | null;
  type: string;
  holder: string | null;
  status: string;
  endDate: string | null;
  /** Cấu hình máy (vd i5/16GB/512GB). */
  configuration?: string | null;
  /** Phần mềm cài trên máy — chuỗi tên license. */
  software?: string | null;
  /** id máy trống — để nút Đặt mở BookingSheet preselect. */
  assetId?: string;
}

export interface ChatAction {
  intent: string;
  params?: Record<string, unknown>;
}

export interface Chip {
  label: string;
  action: ChatAction;
}

export interface DetailRow {
  label: string;
  value: string;
}

/** Chi tiết 1 máy — khối thiết bị (rows) + khối phần mềm tách riêng. */
export interface AssetDetail {
  code: string | null;
  type: string;
  status: string;
  rows: DetailRow[];
  software: string[] | null;
}

export interface ChatReply {
  conversationId: string;
  reply: string;
  cards?: Card[];
  total?: number;
  detail?: AssetDetail;
  chips?: Chip[];
  source: string;
}

export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards?: Card[];
  total?: number;
  detail?: AssetDetail;
  chips?: Chip[];
}

export interface StoredMessage {
  role: string;
  content: string;
  cards: Card[] | null;
  detail: AssetDetail | null;
  chips: Chip[] | null;
}

export interface HistoryResponse {
  conversationId: string;
  messages: StoredMessage[];
}

/** Menu theo vai (thanh cố định). Member CHỈ xoay quanh MƯỢN máy; admin tra cứu/quản lý. */
const MEMBER_MENU: Chip[] = [
  { label: 'Tìm máy trống', action: { intent: 'availability' } },
  { label: 'Máy tôi đang mượn', action: { intent: 'my_borrowings' } },
];
const ADMIN_MENU: Chip[] = [
  { label: 'Tra cứu tài sản', action: { intent: 'list_types' } },
  { label: 'Chờ duyệt', action: { intent: 'pending_approvals' } },
  { label: 'Cảnh báo EOL', action: { intent: 'eol_alerts' } },
];

export function menuFor(role: string): Chip[] {
  return role === 'admin' || role === 'sa' ? ADMIN_MENU : MEMBER_MENU;
}

/** Lời chào (client-side) — kèm tên người dùng nếu có; chip menu bên dưới đã phân vai. */
export function welcomeText(name?: string): string {
  const who = name?.trim() ? name.trim() : 'bạn';
  return `Chào ${who} 👋 Mình là trợ lý QLTS. Chọn nhanh bên dưới hoặc hỏi tự nhiên (vd: "máy nào trống mai", "cấu hình MTS-123") nhé 🙂`;
}

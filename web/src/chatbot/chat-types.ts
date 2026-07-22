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
}

export interface ChatAction {
  intent: string;
  params?: Record<string, unknown>;
}

export interface Chip {
  label: string;
  action: ChatAction;
}

export interface ChatReply {
  conversationId: string;
  reply: string;
  cards?: Card[];
  total?: number;
  chips?: Chip[];
  source: string;
}

export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards?: Card[];
  total?: number;
  chips?: Chip[];
}

export interface StoredMessage {
  role: string;
  content: string;
  cards: Card[] | null;
}

export interface HistoryResponse {
  conversationId: string;
  messages: StoredMessage[];
}

/** Menu theo vai (thanh cố định). Member xoay quanh mượn máy; admin tra cứu tài sản. */
const MEMBER_MENU: Chip[] = [
  { label: 'Tìm máy trống', action: { intent: 'availability' } },
  { label: 'Máy của tôi', action: { intent: 'my_assets' } },
];
const ADMIN_MENU: Chip[] = [
  { label: 'Tra cứu tài sản', action: { intent: 'list_types' } },
  { label: 'Máy của tôi', action: { intent: 'my_assets' } },
];

export function menuFor(role: string): Chip[] {
  return role === 'admin' || role === 'sa' ? ADMIN_MENU : MEMBER_MENU;
}

export const WELCOME_TEXT =
  'Chào bạn 👋 Mình là trợ lý QLTS. Mình giúp tra cứu tài sản, xem máy bạn đang giữ và tìm máy còn trống. Chọn nhanh bên dưới hoặc gõ câu hỏi nhé 🙂';

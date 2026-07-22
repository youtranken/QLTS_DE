/** Thẻ tài sản trả từ BE (khớp AssetCard của chatbot API). */
export interface Card {
  code: string | null;
  type: string;
  holder: string | null;
  status: string;
  endDate: string | null;
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

/** Hành động chính — thanh cố định trên ô nhập (icon SVG gắn theo intent ở action-bar). */
export const MENU_CHIPS: Chip[] = [
  { label: 'Danh sách', action: { intent: 'list_types' } },
  { label: 'Máy của tôi', action: { intent: 'my_assets' } },
  { label: 'Máy trống', action: { intent: 'availability' } },
];

export const WELCOME_TEXT =
  'Chào bạn 👋 Mình là trợ lý QLTS. Mình giúp tra cứu tài sản, xem máy bạn đang giữ và tìm máy còn trống. Chọn nhanh bên dưới hoặc gõ câu hỏi nhé 🙂';

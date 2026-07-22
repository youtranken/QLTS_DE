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

export interface ConversationSummary {
  id: string;
  title: string | null;
  updated_at: string;
}

export interface StoredMessage {
  role: string;
  content: string;
  cards: Card[] | null;
}

/** Chip menu mở đầu — hiển thị client-side, KHÔNG gọi BE khi mới mở (tránh tạo cuộc rỗng). */
export const MENU_CHIPS: Chip[] = [
  { label: '📋 Xem danh sách tài sản', action: { intent: 'list_types' } },
  { label: '🔧 Máy của tôi', action: { intent: 'my_assets' } },
  { label: '🗓️ Tìm máy trống', action: { intent: 'availability' } },
];

export const WELCOME_TEXT = 'Chào bạn 👋 Mình là trợ lý QLTS. Bạn cần gì?';
export const BACK_CHIP: Chip = {
  label: '⬅️ Về đầu',
  action: { intent: 'menu' },
};

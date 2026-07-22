/** Danh tính người gọi (từ req.user) — quyền enforce theo role Ở TOOL, không tin LLM. */
export interface Identity {
  sub: string;
  role: string;
}

/** Thẻ tài sản chuẩn hoá để FE render chung (guided + gemini). */
export interface AssetCard {
  code: string | null;
  type: string;
  /** Người giữ (derive). null với "máy của tôi" / máy trống. */
  holder: string | null;
  status: string;
  endDate: string | null;
  /** Cấu hình máy (vd i5/16GB/512GB) — để trả lời "cấu hình như thế nào". */
  configuration?: string | null;
  /** Phần mềm đang cài trên máy — chuỗi tên license, null nếu không. */
  software?: string | null;
}

/** Chip gợi ý bước kế — FE bấm sẽ gửi lại action này. */
export interface Chip {
  label: string;
  action: { intent: string; params?: Record<string, unknown> };
}

export type ChatSource = 'guided' | 'gemini' | 'fallback';

export interface ChatReply {
  reply: string;
  cards?: AssetCard[];
  total?: number;
  chips?: Chip[];
  source: ChatSource;
}

export interface AssetFilter {
  type?: string;
  status?: string;
  endFrom?: string;
  endTo?: string;
  search?: string;
}

export interface GuidedAction {
  intent: string;
  params?: Record<string, unknown>;
}

export interface ChatRequest {
  conversationId?: string;
  message?: string;
  action?: GuidedAction;
}

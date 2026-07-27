import { useCallback, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  welcomeText,
  type ChatAction,
  type ChatReply,
  type HistoryResponse,
  type Msg,
} from '@/chatbot/chat-types';

const welcomeMsg = (id: string, name?: string): Msg => ({
  id,
  role: 'assistant',
  text: welcomeText(name),
});

/** Trạng thái + hành động chatbot — MỘT luồng/người (lưu lại, mở lại thấy tiếp). */
export function useChatbot(csrfToken: string | null, userName?: string) {
  const idRef = useRef(0);
  const nextId = useCallback(() => String(++idRef.current), []);
  const convId = useRef<string | null>(null);
  // Đã gửi lượt nào chưa → loadHistory (chạy async lúc mở) KHÔNG ghi đè, tránh mất lượt.
  const sentRef = useRef(false);
  const [messages, setMessages] = useState<Msg[]>(() => [
    welcomeMsg('0', userName),
  ]);
  const [loading, setLoading] = useState(false);

  const push = useCallback(
    (m: Omit<Msg, 'id'>) =>
      setMessages((prev) => [...prev, { ...m, id: nextId() }]),
    [nextId],
  );

  /** Nạp đoạn chat cũ của người dùng (get-or-create) — gọi khi mở popup. */
  const loadHistory = useCallback(async () => {
    try {
      const h = await apiFetch<HistoryResponse>('/api/chatbot/history');
      // User đã gửi trong lúc /history còn tải → giữ nguyên UI, đừng ghi đè.
      if (sentRef.current) return;
      convId.current = h.conversationId;
      setMessages(
        h.messages.length
          ? h.messages.map((m) => ({
              id: nextId(),
              role: m.role === 'user' ? 'user' : 'assistant',
              text: m.content,
              cards: m.cards ?? undefined,
              detail: m.detail ?? undefined,
              chips: m.chips ?? undefined,
            }))
          : [welcomeMsg(nextId(), userName)],
      );
    } catch {
      if (sentRef.current) return;
      setMessages([welcomeMsg(nextId(), userName)]);
    }
  }, [nextId, userName]);

  const send = useCallback(
    async (body: { message?: string; action?: ChatAction }) => {
      sentRef.current = true;
      setLoading(true);
      try {
        const r = await apiFetch<ChatReply>('/api/chatbot/message', {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            conversationId: convId.current ?? undefined,
          }),
          csrfToken,
        });
        convId.current = r.conversationId;
        push({
          role: 'assistant',
          text: r.reply,
          cards: r.cards,
          total: r.total,
          detail: r.detail,
          chips: r.chips,
        });
      } catch {
        push({
          role: 'assistant',
          text: 'Có lỗi khi kết nối. Bạn thử lại nhé.',
        });
      } finally {
        setLoading(false);
      }
    },
    [csrfToken, push],
  );

  const sendAction = useCallback(
    (action: ChatAction, echo?: string) => {
      if (echo) push({ role: 'user', text: echo });
      return send({ action });
    },
    [push, send],
  );

  const sendMessage = useCallback(
    (text: string) => {
      push({ role: 'user', text });
      return send({ message: text });
    },
    [push, send],
  );

  /** "Xoá đoạn chat" — xoá sạch ở BE + reset về lời chào. */
  const clearChat = useCallback(async () => {
    try {
      await apiFetch<void>('/api/chatbot/history', {
        method: 'DELETE',
        csrfToken,
      });
    } catch {
      /* nuốt lỗi — vẫn reset UI */
    }
    convId.current = null;
    setMessages([welcomeMsg(nextId(), userName)]);
  }, [csrfToken, nextId, userName]);

  return {
    messages,
    loading,
    sendAction,
    sendMessage,
    loadHistory,
    clearChat,
  };
}

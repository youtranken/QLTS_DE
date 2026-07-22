import { useCallback, useRef, useState } from 'react';
import { apiFetch } from '../api-client';
import {
  WELCOME_TEXT,
  type ChatAction,
  type ChatReply,
  type HistoryResponse,
  type Msg,
} from './chat-types';

const welcomeMsg = (id: string): Msg => ({
  id,
  role: 'assistant',
  text: WELCOME_TEXT,
});

/** Trạng thái + hành động chatbot — MỘT luồng/người (lưu lại, mở lại thấy tiếp). */
export function useChatbot(csrfToken: string | null) {
  const idRef = useRef(0);
  const nextId = useCallback(() => String(++idRef.current), []);
  const convId = useRef<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>(() => [welcomeMsg('0')]);
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
      convId.current = h.conversationId;
      setMessages(
        h.messages.length
          ? h.messages.map((m) => ({
              id: nextId(),
              role: m.role === 'user' ? 'user' : 'assistant',
              text: m.content,
              cards: m.cards ?? undefined,
            }))
          : [welcomeMsg(nextId())],
      );
    } catch {
      setMessages([welcomeMsg(nextId())]);
    }
  }, [nextId]);

  const send = useCallback(
    async (body: { message?: string; action?: ChatAction }) => {
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
    setMessages([welcomeMsg(nextId())]);
  }, [csrfToken, nextId]);

  return {
    messages,
    loading,
    sendAction,
    sendMessage,
    loadHistory,
    clearChat,
  };
}

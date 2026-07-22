import { useCallback, useRef, useState } from 'react';
import { apiFetch } from '../api-client';
import {
  BACK_CHIP,
  MENU_CHIPS,
  WELCOME_TEXT,
  type ChatAction,
  type ChatReply,
  type ConversationSummary,
  type Msg,
  type StoredMessage,
} from './chat-types';

const welcomeMsg = (id: string): Msg => ({
  id,
  role: 'assistant',
  text: WELCOME_TEXT,
  chips: MENU_CHIPS,
});

/** Trạng thái + hành động chatbot. conversationId giữ ở ref (không cần render lại). */
export function useChatbot(csrfToken: string | null) {
  const idRef = useRef(0);
  const nextId = useCallback(() => String(++idRef.current), []);
  const convId = useRef<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>(() => [welcomeMsg('0')]);
  const [loading, setLoading] = useState(false);

  const push = useCallback(
    (m: Omit<Msg, 'id'>) => setMessages((prev) => [...prev, { ...m, id: nextId() }]),
    [nextId],
  );

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
          chips: [BACK_CHIP],
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

  const newChat = useCallback(() => {
    convId.current = null;
    setMessages([welcomeMsg(nextId())]);
  }, [nextId]);

  const listConversations = useCallback(
    () => apiFetch<ConversationSummary[]>('/api/chatbot/conversations'),
    [],
  );

  const loadConversation = useCallback(
    async (id: string) => {
      const rows = await apiFetch<StoredMessage[]>(
        `/api/chatbot/conversations/${id}`,
      );
      convId.current = id;
      setMessages(
        rows.map((r) => ({
          id: nextId(),
          role: r.role === 'user' ? 'user' : 'assistant',
          text: r.content,
          cards: r.cards ?? undefined,
        })),
      );
    },
    [nextId],
  );

  const deleteConversation = useCallback(
    (id: string) =>
      apiFetch<void>(`/api/chatbot/conversations/${id}`, {
        method: 'DELETE',
        csrfToken,
      }),
    [csrfToken],
  );

  return {
    messages,
    loading,
    currentId: convId,
    sendAction,
    sendMessage,
    newChat,
    listConversations,
    loadConversation,
    deleteConversation,
  };
}

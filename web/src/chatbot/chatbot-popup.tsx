import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Me } from '@/lib/me';
import { useConfirm } from '@/ui/confirm-provider';
import { useChatbot } from '@/chatbot/use-chatbot';
import { Mascot } from '@/chatbot/mascot';
import { ChatMessageList } from '@/chatbot/chat-message-list';
import { ChatComposer } from '@/chatbot/chat-composer';
import { ChatDateStep } from '@/chatbot/chat-date-step';
import { ChatActionBar } from '@/chatbot/chat-action-bar';
import type { Card, Chip } from '@/chatbot/chat-types';

type Step =
  | null
  | { kind: 'list'; params: Record<string, unknown>; label: string }
  | { kind: 'avail' };

function initials(name?: string): string {
  const parts = (name ?? '').trim().split(/\s+/);
  const last = parts[parts.length - 1];
  return (last?.[0] ?? 'B').toUpperCase();
}

/** Mascot nổi mọi trang → popup 1 cột, 1 luồng chat (lưu lại), menu ở thanh cố định. */
export function ChatbotPopup({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(null);
  const loadedRef = useRef(false);
  const navigate = useNavigate();
  const chat = useChatbot(me.csrfToken, me.fullName ?? undefined);
  const askConfirm = useConfirm();
  // Quản lý focus (C2): mở → focus panel; đóng → trả focus về FAB. Chat phi-modal (không aria-modal).
  const fabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  const openChat = useCallback(() => {
    setOpen(true);
    if (!loadedRef.current) {
      loadedRef.current = true;
      void chat.loadHistory();
    }
  }, [chat]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
    else if (wasOpen.current) fabRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const onChip = useCallback(
    (chip: Chip) => {
      if (chat.loading) return; // chặn bấm trùng khi đang chờ trả lời
      const { intent, params } = chip.action;
      if (intent === 'list_result') {
        setStep({ kind: 'list', params: params ?? {}, label: chip.label });
        return;
      }
      if (intent === 'availability') {
        setStep({ kind: 'avail' });
        return;
      }
      setStep(null); // chip cũ khi đang mở bước chọn ngày → dọn bước cũ trước khi gửi
      void chat.sendAction(chip.action, chip.label);
    },
    [chat],
  );

  const submitList = (from?: string, to?: string) => {
    if (step?.kind !== 'list') return;
    const params = {
      ...step.params,
      ...(from ? { endFrom: from } : {}),
      ...(to ? { endTo: to } : {}),
    };
    const echo =
      step.label + (from || to ? ` · ${from ?? '…'}→${to ?? '…'}` : '');
    setStep(null);
    void chat.sendAction({ intent: 'list_result', params }, echo);
  };

  const submitAvail = (day: string) => {
    setStep(null);
    void chat.sendAction(
      {
        intent: 'availability',
        params: { from: `${day}T07:00:00+07:00`, to: `${day}T18:00:00+07:00` },
      },
      `Máy trống ${day}`,
    );
  };

  const seeAll = () => {
    setOpen(false);
    navigate('/assets');
  };

  // Member đặt máy: mở màn Đặt máy sẵn có (trang chủ) với máy đã chọn — BookingSheet preselect.
  const bookNow = (card: Card) => {
    setOpen(false);
    navigate('/', {
      state: card.assetId
        ? {
            book: {
              id: card.assetId,
              code: card.code ?? '',
              type: card.type,
              configuration: card.configuration ?? null,
            },
          }
        : undefined,
    });
  };

  const clearChat = async () => {
    const ok = await askConfirm({
      title: 'Xoá đoạn chat',
      message: 'Xoá toàn bộ đoạn chat này? Không thể hoàn tác.',
      confirmLabel: 'Xoá',
      danger: true,
    });
    if (ok) {
      setStep(null);
      void chat.clearChat();
    }
  };

  if (!open) {
    return (
      <button
        ref={fabRef}
        type="button"
        className="qc-fab"
        aria-label="Mở trợ lý QLTS"
        onClick={openChat}
      >
        <Mascot />
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Trợ lý QLTS"
      className="qc-panel"
    >
      <div className="qc-head">
        <div className="qc-ava">
          <Mascot />
        </div>
        <div className="qc-who">
          <div className="qc-nm">Trợ lý QLTS</div>
          <div className="qc-status">
            <i />
            Trực tuyến
          </div>
        </div>
        <button
          type="button"
          className="qc-iconbtn"
          aria-label="Xoá đoạn chat"
          title="Xoá đoạn chat"
          onClick={clearChat}
        >
          {/* lucide Trash2 (đồng bộ với QLHS — 2 vạch trong) */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
        <button
          type="button"
          className="qc-iconbtn"
          aria-label="Đóng trợ lý"
          onClick={() => setOpen(false)}
        >
          {/* lucide X (đồng bộ với QLHS) */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <ChatMessageList
        messages={chat.messages}
        loading={chat.loading}
        meInitials={initials(me.fullName)}
        onChip={onChip}
        onSeeAll={seeAll}
        onBook={bookNow}
      />

      {step ? (
        <ChatDateStep
          mode={step.kind}
          onList={submitList}
          onAvail={submitAvail}
          onCancel={() => setStep(null)}
        />
      ) : (
        <>
          <ChatActionBar role={me.role} onPick={onChip} disabled={chat.loading} />
          <ChatComposer
            disabled={chat.loading}
            onSend={(t) => void chat.sendMessage(t)}
          />
        </>
      )}
    </div>
  );
}

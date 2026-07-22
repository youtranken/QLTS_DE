import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Me } from '../me';
import { useChatbot } from './use-chatbot';
import { Mascot } from './mascot';
import { ChatMessageList } from './chat-message-list';
import { ChatComposer } from './chat-composer';
import { ChatDateStep } from './chat-date-step';
import { ChatActionBar } from './chat-action-bar';
import type { Card, Chip } from './chat-types';

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
  const chat = useChatbot(me.csrfToken);

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

  const onChip = useCallback(
    (chip: Chip) => {
      const { intent, params } = chip.action;
      if (intent === 'list_result') {
        setStep({ kind: 'list', params: params ?? {}, label: chip.label });
        return;
      }
      if (intent === 'availability') {
        setStep({ kind: 'avail' });
        return;
      }
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

  const clearChat = () => {
    if (window.confirm('Xoá toàn bộ đoạn chat này?')) {
      setStep(null);
      void chat.clearChat();
    }
  };

  if (!open) {
    return (
      <button
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
    <div className="qc-panel">
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
        <button
          type="button"
          className="qc-iconbtn"
          aria-label="Đóng trợ lý"
          onClick={() => setOpen(false)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
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
          <ChatActionBar role={me.role} onPick={onChip} />
          <ChatComposer
            disabled={chat.loading}
            onSend={(t) => void chat.sendMessage(t)}
          />
        </>
      )}
    </div>
  );
}

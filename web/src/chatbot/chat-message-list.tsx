import { useEffect, useRef } from 'react';
import { Mascot } from './mascot';
import { ChatResultCard } from './chat-result-card';
import type { Chip, Msg } from './chat-types';

/** Danh sách tin nhắn + typing; render card/chips của từng bong bóng assistant. */
export function ChatMessageList({
  messages,
  loading,
  meInitials,
  onChip,
  onSeeAll,
}: {
  messages: Msg[];
  loading: boolean;
  meInitials: string;
  onChip: (chip: Chip) => void;
  onSeeAll: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // jsdom (test) không có scrollIntoView — guard optional call.
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, loading]);

  return (
    <div className="qc-msgs">
      {messages.map((m) => (
        <div key={m.id} className={`qc-row qc-${m.role === 'user' ? 'user' : 'ai'}`}>
          <div className={`qc-mava qc-${m.role === 'user' ? 'me' : 'ai'}`}>
            {m.role === 'user' ? meInitials : <Mascot />}
          </div>
          <div className="qc-bubble">
            <div>{m.text}</div>
            {m.cards && m.cards.length > 0 && (
              <ChatResultCard cards={m.cards} total={m.total} onSeeAll={onSeeAll} />
            )}
            {m.chips && m.chips.length > 0 && (
              <div className="qc-chips">
                {m.chips.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`qc-chip${c.action.intent === 'menu' ? ' qc-ghost' : ''}`}
                    onClick={() => onChip(c)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      {loading && (
        <div className="qc-row qc-ai">
          <div className="qc-mava qc-ai">
            <Mascot />
          </div>
          <div className="qc-bubble">
            <div className="qc-typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

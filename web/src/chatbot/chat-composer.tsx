import { useState } from 'react';

/** Ô gõ từ khoá tìm tài sản (mã/tên/cấu hình). Enter gửi, Shift+Enter xuống dòng. */
export function ChatComposer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };
  return (
    <div className="qc-composer">
      <textarea
        rows={1}
        placeholder="Tìm tài sản theo từ khoá (mã, tên, cấu hình)…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="button"
        className="qc-send"
        aria-label="Gửi"
        disabled={disabled || !text.trim()}
        onClick={submit}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );
}

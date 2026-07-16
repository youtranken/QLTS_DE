import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { TimePicker, type TimeValue } from './time-picker';
import './time-field.css';

const pad = (n: number) => String(n).padStart(2, '0');

/** 'HH:MM' (24h) → TimeValue bánh xe (12h + AM/PM). Rỗng/không hợp lệ → 08:00 sáng. */
function parse(s: string): TimeValue {
  const [hh, mm] = s.split(':');
  const h = Number(hh);
  const m = Number(mm);
  if (!s || Number.isNaN(h)) return { hour: 8, minute: 0, pm: false };
  return { hour: ((h + 11) % 12) + 1, minute: Number.isNaN(m) ? 0 : m, pm: h >= 12 };
}
/** TimeValue (12h+AM/PM) → 'HH:MM' (24h) để khớp state booking + input cũ. */
function fmt(v: TimeValue): string {
  const h24 = v.pm ? (v.hour % 12) + 12 : v.hour % 12;
  return `${pad(h24)}:${pad(v.minute)}`;
}

/**
 * Ô chọn giờ kiểu bánh xe (time-picker.html) cho Giờ nhận/trả — drop-in cho input[type=time]:
 * value/onChange là 'HH:MM' 24h. Popover dùng position:fixed neo theo nút → KHÔNG bị overflow
 * của sheet-body cắt (giống DatePicker). Done chốt; ngoài/Cancel đóng.
 */
export function TimeField({
  value,
  onChange,
  ariaLabel,
  onFocus,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  /** Gọi khi mở picker — để chip "Gợi ý giờ" biết đang thao tác ô nào (nhận/trả). */
  onFocus?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [popStyle, setPopStyle] = useState<CSSProperties>();

  // Neo popover theo nút (fixed) + tự lật LÊN khi dưới thiếu chỗ; canh phải để không tràn mép.
  useEffect(() => {
    if (!open) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const POP_W = 256;
    const POP_H = 360;
    const below = window.innerHeight - r.bottom;
    const top = below < POP_H && r.top > POP_H ? r.top - POP_H - 4 : r.bottom + 4;
    let left = r.right - POP_W;
    left = Math.max(8, Math.min(left, window.innerWidth - POP_W - 8));
    setPopStyle({ position: 'fixed', top, left, zIndex: 1000 });
  }, [open]);

  // Đóng khi bấm ra ngoài — popover ở PORTAL (body) nên phải loại trừ cả nút LẪN popover.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (
        !rootRef.current?.contains(tgt) &&
        !popRef.current?.contains(tgt)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="tf" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tf-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          onFocus?.();
          setOpen((o) => !o);
        }}
      >
        <span className={`tf-val${value ? '' : ' ph'}`}>{value || '--:--'}</span>
        <svg
          className="tf-clock"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div className="tf-pop" role="dialog" style={popStyle} ref={popRef}>
            <TimePicker
              value={parse(value)}
              onDone={(v) => {
                onChange(fmt(v));
                setOpen(false);
              }}
              onCancel={() => setOpen(false)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

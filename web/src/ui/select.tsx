import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface SelectOption {
  value: string;
  label: ReactNode;
}

/**
 * Select tùy biến (thay <select> native có popup vuông góc xấu). Menu bo góc + shadow theo
 * hệ Sunset Grove, mũi tên › thống nhất. Popover position:fixed neo theo nút → KHÔNG bị
 * overflow của sheet/table cắt; tự lật lên khi dưới thiếu chỗ. Keyboard: ↑/↓/Enter/Esc.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  /** Nhãn khi chưa chọn (value=''). Nếu bỏ trống, hiện option đầu. */
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popStyle, setPopStyle] = useState<CSSProperties>();

  const selected = options.find((o) => o.value === value);
  const label = selected ? selected.label : (placeholder ?? '—');

  useEffect(() => {
    if (!open) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const POP_MAX = 288;
    const below = window.innerHeight - r.bottom;
    const flipUp = below < Math.min(POP_MAX, options.length * 40 + 12) && r.top > below;
    setPopStyle({
      position: 'fixed',
      left: r.left,
      width: r.width,
      zIndex: 1000,
      ...(flipUp
        ? { bottom: window.innerHeight - r.top + 4 }
        : { top: r.bottom + 4 }),
    });
    const idx = options.findIndex((o) => o.value === value);
    setActive(idx < 0 ? 0 : idx);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={`fsel${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="fsel-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            setActive((i) =>
              e.key === 'ArrowDown'
                ? Math.min(i + 1, options.length - 1)
                : Math.max(i - 1, 0),
            );
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            const o = options[active];
            if (o) choose(o.value);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <span className={selected ? 'fsel-val' : 'fsel-val ph'}>{label}</span>
        <span className="fsel-caret" aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <ul className="fsel-menu" role="listbox" style={popStyle}>
          {options.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`fsel-option${i === active ? ' active' : ''}${o.value === value ? ' sel' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o.value)}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAnchoredMenu } from './use-anchored-menu';
import { useDialogPortal } from './dialog';

export interface SelectOption {
  value: string;
  label: ReactNode;
}

/**
 * Select tùy biến (thay <select> native có popup vuông góc xấu). Menu bo góc + shadow theo
 * hệ Sunset Grove, mũi tên chevron THỐNG NHẤT với DatePicker. Menu PORTAL ra body +
 * position:fixed neo theo nút → KHÔNG bị overflow của sheet/table cắt VÀ không bị ancestor
 * có transform (modal animate) làm fixed neo sai (menu "văng khỏi" trigger). Tự lật lên khi
 * dưới thiếu chỗ. Keyboard: ↑/↓/Enter/Esc.
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portal = useDialogPortal();

  const selected = options.find((o) => o.value === value);
  const label = selected ? selected.label : (placeholder ?? '—');

  const { refs, floatingStyles } = useAnchoredMenu(open, {
    matchWidth: true,
    maxHeight: 288,
  });

  // Mở → active = option đang chọn.
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setActive(idx < 0 ? 0 : idx);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        refs.domReference.current?.contains(target) ||
        refs.floating.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, refs.domReference, refs.floating]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      className={`fsel${className ? ` ${className}` : ''}`}
      ref={refs.setReference}
    >
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
        <svg
          className="fsel-caret"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        createPortal(
          <ul
            className="fsel-menu"
            role="listbox"
            style={floatingStyles}
            ref={refs.setFloating}
          >
            {/* Không có lựa chọn nào → báo rõ thay vì ô nổi trống trơ (review D3). */}
            {options.length === 0 && (
              <li className="fsel-none" aria-disabled="true">
                {t('select.noOptions', '— Không có lựa chọn —')}
              </li>
            )}
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
          </ul>,
          portal ?? document.body,
        )}
    </div>
  );
}

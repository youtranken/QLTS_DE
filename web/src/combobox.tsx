import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ComboboxProps<T> {
  placeholder: string;
  query: string;
  onQuery: (value: string) => void;
  options: T[];
  getKey: (option: T) => string;
  /** Nội dung một dòng gợi ý (dùng <span> cho nhãn chính, <small> cho phụ). */
  renderOption: (option: T) => ReactNode;
  onSelect: (option: T) => void;
  disabled?: boolean;
}

/**
 * Autocomplete có style dùng chung (thay <ul><li><button> trần).
 * Menu chỉ hiện khi có kết quả — parent tự fetch theo query (debounce ở parent).
 * Điều hướng: ↑/↓ chọn dòng, Enter chốt, Esc đóng menu.
 * Menu PORTAL ra body + position:fixed neo theo ô input → KHÔNG bị overflow của .sheet-body /
 * bảng cắt (trước đây gợi ý mở gần đáy popup Chuyển/Sửa bị che). Tự lật lên khi dưới thiếu chỗ.
 */
export function Combobox<T>({
  placeholder,
  query,
  onQuery,
  options,
  getKey,
  renderOption,
  onSelect,
  disabled,
}: ComboboxProps<T>) {
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLUListElement>(null);
  const [popStyle, setPopStyle] = useState<CSSProperties>();

  // options đổi (query mới) → về đầu danh sách và mở lại menu
  useEffect(() => {
    setActive(0);
    setClosed(false);
  }, [options]);

  const open = options.length > 0 && !closed;

  const reposition = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const POP_MAX = 260;
    const below = window.innerHeight - r.bottom;
    // Lật lên khi dưới thiếu chỗ mà trên rộng hơn.
    const flipUp = below < Math.min(POP_MAX, 200) && r.top > below;
    setPopStyle({
      position: 'fixed',
      left: r.left,
      width: r.width,
      right: 'auto',
      zIndex: 1000,
      ...(flipUp
        ? { bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(POP_MAX, r.top - 8) }
        : { top: r.bottom + 4, maxHeight: Math.min(POP_MAX, below - 8) }),
    });
  }, []);

  // Neo lại khi mở / đổi gợi ý / cuộn / resize (capture=true để bắt cả cuộn trong .sheet-body).
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onMove = () => reposition();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, reposition]);

  // Bấm ngoài đóng menu (menu ở portal, không nằm trong .combo).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setClosed(true);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const choose = (option: T) => {
    onSelect(option);
    setClosed(true);
  };

  return (
    <div className="combo" ref={rootRef}>
      <input
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          onQuery(e.target.value);
          setClosed(false);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const option = options[active];
            if (option) choose(option);
          } else if (e.key === 'Escape') {
            // đóng menu tại chỗ — KHÔNG để Escape lan lên đóng cả modal
            e.stopPropagation();
            setClosed(true);
          }
        }}
      />
      {open &&
        createPortal(
          <ul className="combo-menu" ref={popRef} role="listbox" style={popStyle}>
            {options.map((option, i) => (
              <li key={getKey(option)}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  disabled={disabled}
                  className={`combo-option${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(option)}
                >
                  {renderOption(option)}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}

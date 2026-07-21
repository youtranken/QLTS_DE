import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredMenu } from './ui/use-anchored-menu';

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
  const inputRef = useRef<HTMLInputElement>(null);

  // options đổi (query mới) → về đầu danh sách và mở lại menu
  useEffect(() => {
    setActive(0);
    setClosed(false);
  }, [options]);

  const open = options.length > 0 && !closed;
  const { refs, floatingStyles } = useAnchoredMenu(open, {
    matchWidth: true,
    maxHeight: 260,
  });

  // Bấm ngoài đóng menu (menu ở portal, không nằm trong .combo).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        refs.domReference.current?.contains(target) ||
        refs.floating.current?.contains(target)
      )
        return;
      setClosed(true);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, refs.domReference, refs.floating]);

  const choose = (option: T) => {
    onSelect(option);
    setClosed(true);
  };

  // Mũi tên bung/đóng như dropdown: đóng → mở lại (nếu có gợi ý) và focus để gõ lọc.
  const toggle = () => {
    if (open) {
      setClosed(true);
    } else {
      setClosed(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className={`combo${open ? ' open' : ''}`} ref={refs.setReference}>
      <input
        ref={inputRef}
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
      {/* Mũi tên chevron THỐNG NHẤT với Select/DatePicker — bấm để bung/đóng danh sách. */}
      <button
        type="button"
        className="combo-caret"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onClick={toggle}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open &&
        createPortal(
          <ul
            className="combo-menu"
            ref={refs.setFloating}
            role="listbox"
            style={floatingStyles}
          >
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

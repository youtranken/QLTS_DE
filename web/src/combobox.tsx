import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

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

  // options đổi (query mới) → về đầu danh sách và mở lại menu
  useEffect(() => {
    setActive(0);
    setClosed(false);
  }, [options]);

  const open = options.length > 0 && !closed;
  const listRef = useRef<HTMLUListElement>(null);

  const choose = (option: T) => {
    onSelect(option);
    setClosed(true);
  };

  return (
    <div className="combo">
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
      {open && (
        <ul className="combo-menu" ref={listRef} role="listbox">
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
        </ul>
      )}
    </div>
  );
}

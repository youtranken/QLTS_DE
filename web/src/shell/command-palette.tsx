import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toggleTheme } from '@/lib/theme';

/** Bỏ dấu tiếng Việt để lọc không phân biệt dấu (gõ "tai san" khớp "Tài sản"). */
const deaccent = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

type Cmd = { id: string; label: string; group: string; run: () => void };

/**
 * Command palette ⌘K/Ctrl+K (UP-5.4): tìm trang + hành động nhanh bằng bàn phím.
 * Tự quản open state qua global keydown; overlay riêng. "Gần đây" hoãn (cần lưu trạng thái).
 */
export function CommandPalette({
  navItems,
  onLogout,
}: {
  navItems: Array<{ to: string; label: string }>;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mở bằng ⌘K / Ctrl+K ở bất kỳ đâu; hoặc nút search ở topbar phát event 'qlts:cmdk'.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('qlts:cmdk', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('qlts:cmdk', onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = navItems.map((n) => ({
      id: `nav:${n.to}`,
      label: n.label,
      group: t('cmd.navigate', 'Điều hướng'),
      run: () => navigate(n.to),
    }));
    const actions: Cmd[] = [
      {
        id: 'act:theme',
        label: t('cmd.toggleTheme', 'Đổi giao diện sáng/tối'),
        group: t('cmd.actions', 'Hành động'),
        run: () => toggleTheme(),
      },
      {
        id: 'act:logout',
        label: t('app.logout'),
        group: t('cmd.actions', 'Hành động'),
        run: onLogout,
      },
    ];
    return [...nav, ...actions];
  }, [navItems, navigate, onLogout, t]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = deaccent(query);
    return commands.filter((c) => deaccent(c.label).includes(q));
  }, [commands, query]);

  // active luôn nằm trong danh sách đã lọc
  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered, active]);

  if (!open) return null;

  const runAt = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    }
  };

  // Nhóm hiển thị theo group, giữ index phẳng để ↑↓ chạy xuyên nhóm.
  let flatIndex = -1;
  const groups = [...new Set(filtered.map((c) => c.group))];

  return (
    <div className="cp-wrap" onMouseDown={() => setOpen(false)}>
      <div
        className="cp show"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cp-search">
          <span className="cp-search-ic" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={t('cmd.placeholder', 'Tìm trang, hành động…')}
            aria-label={t('cmd.placeholder', 'Tìm trang, hành động…')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="cp-list">
          {filtered.length === 0 ? (
            <div className="cp-empty">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <p>{t('cmd.empty', 'Không có kết quả.')}</p>
            </div>
          ) : (
            groups.map((g) => (
              <div className="cp-group" key={g}>
                <p className="cp-group-title">{g}</p>
                {filtered
                  .filter((c) => c.group === g)
                  .map((c) => {
                    flatIndex += 1;
                    const i = flatIndex;
                    return (
                      <button
                        type="button"
                        key={c.id}
                        className={i === active ? 'cp-item active' : 'cp-item'}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => runAt(i)}
                      >
                        <span className="it-ic">{c.label.charAt(0)}</span>
                        <span className="it-name">{c.label}</span>
                        <span className="it-arrow" aria-hidden="true">
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </span>
                      </button>
                    );
                  })}
              </div>
            ))
          )}
        </div>
        <div className="cp-foot">
          <span className="fh">
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t('cmd.move', 'di chuyển')}
          </span>
          <span className="fh">
            <kbd>↵</kbd> {t('cmd.openHint', 'mở')}
          </span>
          <span className="fh">
            <kbd>esc</kbd> {t('cmd.closeHint', 'đóng')}
          </span>
        </div>
      </div>
    </div>
  );
}

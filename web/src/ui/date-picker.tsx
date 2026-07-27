import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAnchoredMenu } from '@/ui/use-anchored-menu';
import { useDialogPortal } from '@/ui/dialog';

/**
 * DatePicker (port từ mockup date-picker.html, adapt token Sunset Grove).
 * Drop-in cho `<input type="date">`: value/onChange đều là chuỗi 'YYYY-MM-DD' (rỗng = chưa chọn).
 * Popover lịch: xem ngày + drill tháng/năm; đóng khi chọn / bấm ngoài / Esc.
 */
export function DatePicker({
  value,
  onChange,
  placeholder,
  id,
  ariaLabel,
  clearable = true,
  min,
  max,
  disabled = false,
  blockWeekend = false,
  blockSunday = false,
  bookableDays,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  clearable?: boolean;
  /** Chặn chọn ngày < min / > max (chuỗi 'YYYY-MM-DD') — như thuộc tính min/max của input date. */
  min?: string;
  max?: string;
  /** Khóa ô (không mở lịch, làm mờ) — vd ngày trả tự động = nhận + 2 ở chế độ Thường. */
  disabled?: boolean;
  /** Chặn chọn Thứ 7 & Chủ nhật (vd ngày trả không được rơi vào cuối tuần). */
  blockWeekend?: boolean;
  /** Chỉ chặn Chủ nhật (Thứ 7 vẫn là ngày làm — T2–T7). */
  blockSunday?: boolean;
  /** Ngày làm việc cấu hình (ISO 1=T2..7=CN) — nếu có, chặn mọi ngày KHÔNG thuộc set này
   *  (thay blockSunday/blockWeekend, để form Đặt máy theo config SA chỉnh — audit H3). */
  bookableDays?: number[];
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'day' | 'month' | 'year'>('day');
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Popover portal ra body (thoát overflow sheet/table + ancestor transform); Floating UI lo
  // flip/shift/collision + autoUpdate. z-index/hình từ CSS .dp-pop.
  const { refs, floatingStyles } = useAnchoredMenu(open, { maxHeight: 360 });
  const portal = useDialogPortal();

  // Ngày đang chọn (parse value) + tháng đang xem.
  const selected = useMemo(() => parseISO(value), [value]);
  const [cursor, setCursor] = useState(() => selected ?? new Date());

  // Mở lại thì đưa con trỏ về tháng của ngày đã chọn (nếu có).
  useEffect(() => {
    if (open) {
      setCursor(selected ?? new Date());
      setView('day');
    }
  }, [open, selected]);

  // Đóng khi bấm ngoài / Esc.
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, refs.domReference, refs.floating]);

  const label = useMemo(() => {
    if (!selected) return placeholder ?? t('datePicker.choose');
    return selected.toLocaleDateString(i18n.language, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }, [selected, placeholder, t, i18n.language]);

  const minD = useMemo(() => parseISO(min ?? ''), [min]);
  const maxD = useMemo(() => parseISO(max ?? ''), [max]);
  const outOfRange = useCallback(
    (d: Date) =>
      (minD !== null && d < stripTime(minD)) ||
      (maxD !== null && d > stripTime(maxD)) ||
      // ISO 1=T2..7=CN (JS getDay 0=CN → 7). bookableDays có → ưu tiên (config SA chỉnh).
      (bookableDays
        ? !bookableDays.includes(d.getDay() === 0 ? 7 : d.getDay())
        : // 0 = Chủ nhật, 6 = Thứ 7
          (blockWeekend && (d.getDay() === 0 || d.getDay() === 6)) ||
          (blockSunday && d.getDay() === 0)),
    [minD, maxD, blockWeekend, blockSunday, bookableDays],
  );

  const pick = useCallback(
    (d: Date) => {
      if (outOfRange(d)) return;
      onChange(toISO(d));
      setOpen(false);
    },
    [onChange, outOfRange],
  );

  const step = (dir: number) => {
    setCursor((c) => {
      const n = new Date(c);
      if (view === 'day') n.setMonth(n.getMonth() + dir);
      else if (view === 'month') n.setFullYear(n.getFullYear() + dir);
      else n.setFullYear(n.getFullYear() + dir * 10);
      return n;
    });
  };

  const monthNames = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) =>
        new Date(2000, i, 1).toLocaleDateString(i18n.language, { month: 'short' }),
      ),
    [i18n.language],
  );
  const weekdayNames = useMemo(() => {
    // Bắt đầu Thứ 2 (VN). 2024-01-01 là Thứ 2.
    return Array.from({ length: 7 }, (_, i) =>
      new Date(2024, 0, 1 + i).toLocaleDateString(i18n.language, {
        weekday: 'narrow',
      }),
    );
  }, [i18n.language]);

  return (
    <div className={`dp${open ? ' open' : ''}`} ref={refs.setReference}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className="dp-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="4" width="18" height="17" rx="3" />
          <path d="M8 2v4M16 2v4M3 10h18" />
        </svg>
        <span className={selected ? 'dp-val' : 'dp-val ph'}>{label}</span>
        {clearable && selected && (
          <span
            className="dp-clear"
            role="button"
            aria-label={t('datePicker.clear')}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onChange('');
              }
            }}
          >
            ✕
          </span>
        )}
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            className="dp-pop"
            role="dialog"
            style={floatingStyles}
            ref={refs.setFloating}
          >
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => step(-1)} aria-label={t('datePicker.prev')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <button
              type="button"
              className="dp-title"
              onClick={() =>
                setView((v) => (v === 'day' ? 'month' : v === 'month' ? 'year' : 'year'))
              }
            >
              {view === 'day'
                ? `${monthNames[cursor.getMonth()]} ${cursor.getFullYear()}`
                : view === 'month'
                  ? `${cursor.getFullYear()}`
                  : `${decadeStart(cursor)}–${decadeStart(cursor) + 9}`}
            </button>
            <button type="button" className="dp-nav" onClick={() => step(1)} aria-label={t('datePicker.next')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="dp-body">
            {view === 'day' && (
              <>
                <div className="dp-week">
                  {weekdayNames.map((w, i) => (
                    <span key={i}>{w}</span>
                  ))}
                </div>
                <div className="dp-grid days">
                  {buildDays(cursor).map((cell, i) => {
                    const isSel = selected && sameDay(cell.date, selected);
                    const isToday = sameDay(cell.date, new Date());
                    const disabled = outOfRange(cell.date);
                    return (
                      <button
                        key={i}
                        type="button"
                        disabled={disabled}
                        className={`dp-cell${cell.dim ? ' dim' : ''}${isSel ? ' sel' : ''}${isToday && !isSel ? ' today' : ''}`}
                        onClick={() => pick(cell.date)}
                      >
                        {cell.date.getDate()}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {view === 'month' && (
              <div className="dp-grid months">
                {monthNames.map((mo, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`dp-cell${selected && selected.getFullYear() === cursor.getFullYear() && selected.getMonth() === i ? ' sel' : ''}`}
                    onClick={() => {
                      setCursor((c) => {
                        const n = new Date(c);
                        n.setMonth(i);
                        return n;
                      });
                      setView('day');
                    }}
                  >
                    {mo}
                  </button>
                ))}
              </div>
            )}
            {view === 'year' && (
              <div className="dp-grid years">
                {buildYears(cursor).map((y) => (
                  <button
                    key={y}
                    type="button"
                    className={`dp-cell${selected && selected.getFullYear() === y ? ' sel' : ''}`}
                    onClick={() => {
                      setCursor((c) => {
                        const n = new Date(c);
                        n.setFullYear(y);
                        return n;
                      });
                      setView('month');
                    }}
                  >
                    {y}
                  </button>
                ))}
              </div>
            )}
          </div>
          </div>,
          portal ?? document.body,
        )}
    </div>
  );
}

function parseISO(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function toISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function decadeStart(d: Date): number {
  return Math.floor(d.getFullYear() / 10) * 10;
}
function buildDays(cursor: Date): Array<{ date: Date; dim: boolean }> {
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  // Ô đầu lưới = Thứ 2 của tuần chứa ngày 1 (tuần bắt đầu Thứ 2).
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // 0=Thứ2
  const start = new Date(y, m, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { date, dim: date.getMonth() !== m };
  });
}
function buildYears(cursor: Date): number[] {
  const s = decadeStart(cursor);
  return Array.from({ length: 12 }, (_, i) => s - 1 + i);
}

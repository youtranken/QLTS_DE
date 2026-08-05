import { useTranslation } from 'react-i18next';
import { Select } from '@/ui/select';
import { TimeField } from '@/ui/time-field';
import {
  monthlyWeekdayDates,
  type SessionRow,
  type WorkHoursCfg,
} from '@/features/booking/booking-types';

const WEEKDAY_LABELS: Record<number, string> = {
  1: 'Thứ 2',
  2: 'Thứ 3',
  3: 'Thứ 4',
  4: 'Thứ 5',
  5: 'Thứ 6',
  6: 'Thứ 7',
  7: 'Chủ nhật',
};

const dateOf = (s: SessionRow) => s.from.slice(0, 10);
const timeOf = (dt: string) => (dt.length >= 16 ? dt.slice(11, 16) : '');

export interface RecurringSessionPickerProps {
  workingHours: WorkHoursCfg;
  weekday: number | '';
  onWeekday: (w: number) => void;
  sessions: SessionRow[];
  onChange: (rows: SessionRow[]) => void;
  stuck: number | null;
}

/**
 * Chọn ĐỊNH KỲ theo THỨ trong tuần: chọn 1 thứ → sinh các buổi = tất cả ngày thứ đó TỪ hôm nay
 * tới cuối tháng. Không thêm buổi tùy ý (tránh spam). Mỗi buổi CHỈNH giờ nhận/trả riêng.
 */
export function RecurringSessionPicker({
  workingHours,
  weekday,
  onWeekday,
  sessions,
  onChange,
  stuck,
}: RecurringSessionPickerProps) {
  const { t } = useTranslation();
  // Định kỳ chỉ cho T2–T6 (ISO 1..5): bỏ Thứ 7 (6) và Chủ nhật (7), trong phạm vi ngày làm việc.
  const options = workingHours.days
    .filter((d) => d >= 1 && d <= 5)
    .sort((a, b) => a - b);

  const pickWeekday = (w: number) => {
    onWeekday(w);
    const dates = monthlyWeekdayDates(w);
    onChange(
      dates.map((d) => ({
        from: `${d}T${workingHours.start}`,
        to: `${d}T${workingHours.end}`,
      })),
    );
  };
  const setTime = (i: number, side: 'from' | 'to', time: string) =>
    onChange(
      sessions.map((s, j) =>
        j === i ? { ...s, [side]: `${dateOf(s)}T${time}` } : s,
      ),
    );
  const removeRow = (i: number) =>
    onChange(sessions.filter((_, j) => j !== i));

  const fmtDate = (iso: string) =>
    new Date(`${iso}T00:00`).toLocaleDateString('vi-VN', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    });

  return (
    <>
      <label className="field" style={{ maxWidth: 280 }}>
        <span>{t('recur.weekday', 'Chọn thứ trong tuần')}</span>
        <Select
          value={weekday === '' ? '' : String(weekday)}
          onChange={(v) => v && pickWeekday(Number(v))}
          options={options.map((d) => ({
            value: String(d),
            label: WEEKDAY_LABELS[d],
          }))}
          placeholder={t('recur.weekdayPick', '— Chọn thứ —')}
          ariaLabel={t('recur.weekday', 'Chọn thứ trong tuần')}
        />
      </label>

      {weekday !== '' && sessions.length === 0 && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          {t('recur.noOccurrence', 'Tháng này không còn ngày nào của thứ đã chọn.')}
        </p>
      )}

      {sessions.map((s, i) => (
        <div
          key={dateOf(s)}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            padding: 8,
            borderRadius: 8,
            border: `1px solid ${stuck === i ? 'var(--danger)' : 'var(--border)'}`,
            background: stuck === i ? 'var(--danger-soft)' : 'transparent',
          }}
        >
          <span
            className="mono"
            style={{ flex: '0 0 auto', minWidth: 96, paddingBottom: 6 }}
          >
            {fmtDate(dateOf(s))}
          </span>
          <label className="field" style={{ flex: 1, minWidth: 0 }}>
            <span>{t('recur.from', 'Giờ nhận')}</span>
            <TimeField
              value={timeOf(s.from)}
              ariaLabel={`${t('recur.from', 'Giờ nhận')} ${fmtDate(dateOf(s))}`}
              onChange={(v) => setTime(i, 'from', v)}
            />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 0 }}>
            <span>{t('recur.to', 'Giờ trả')}</span>
            <TimeField
              value={timeOf(s.to)}
              ariaLabel={`${t('recur.to', 'Giờ trả')} ${fmtDate(dateOf(s))}`}
              onChange={(v) => setTime(i, 'to', v)}
            />
          </label>
          <button
            type="button"
            className="ghost sm icon-x"
            aria-label={t('recur.removeSession', 'Bỏ buổi')}
            onClick={() => removeRow(i)}
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}

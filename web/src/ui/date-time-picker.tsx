import { useTranslation } from 'react-i18next';
import { DatePicker } from './date-picker';
import { TimeField } from '../time-field';

/**
 * DateTimePicker: ghép DatePicker (Sunset Grove) cho phần NGÀY + ô giờ cho phần GIỜ.
 * value/onChange dạng 'YYYY-MM-DDTHH:mm' (drop-in thay <input type="datetime-local">).
 * Chọn ngày trước, giờ mặc định 08:00 tới khi đổi; xóa ngày → xóa cả giá trị.
 */
export function DateTimePicker({
  value,
  onChange,
  ariaLabel,
  min,
  clearable = true,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  /** Chặn ngày trước min (nhận 'YYYY-MM-DD' hoặc 'YYYY-MM-DDTHH:mm' — chỉ dùng phần ngày). */
  min?: string;
  clearable?: boolean;
}) {
  const { t } = useTranslation();
  const [datePart, timePart] = split(value);
  const emit = (d: string, tm: string) => {
    if (!d) {
      onChange('');
      return;
    }
    onChange(`${d}T${tm || '08:00'}`);
  };
  return (
    <div className="dtp">
      <DatePicker
        value={datePart}
        ariaLabel={ariaLabel}
        min={min ? min.split('T')[0] : undefined}
        clearable={clearable}
        onChange={(d) => emit(d, timePart)}
      />
      <div className="dtp-time">
        <TimeField
          value={timePart}
          ariaLabel={ariaLabel ? `${ariaLabel} — ${t('datePicker.time', 'giờ')}` : undefined}
          disabled={!datePart}
          onChange={(tm) => emit(datePart, tm)}
        />
      </div>
    </div>
  );
}

function split(v: string): [string, string] {
  if (!v) return ['', ''];
  const [d, tm] = v.split('T');
  return [d ?? '', (tm ?? '').slice(0, 5)];
}

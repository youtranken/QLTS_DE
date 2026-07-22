import { useState } from 'react';
import { DatePicker } from '../ui/date-picker';

/** Bước chọn ngày: 'list' = lọc hạn (from→to, có Bỏ qua); 'avail' = ngày cần mượn. */
export function ChatDateStep({
  mode,
  onList,
  onAvail,
  onCancel,
}: {
  mode: 'list' | 'avail';
  onList: (from?: string, to?: string) => void;
  onAvail: (day: string) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [day, setDay] = useState('');

  if (mode === 'avail') {
    return (
      <div className="qc-step">
        <div className="qc-step-label">
          Chọn ngày cần mượn (giờ hành chính 07:00–18:00):
        </div>
        <div className="qc-step-row">
          <DatePicker
            value={day}
            onChange={setDay}
            placeholder="Chọn ngày"
            blockSunday
          />
        </div>
        <div className="qc-step-actions">
          <button type="button" className="qc-btn" onClick={onCancel}>
            Huỷ
          </button>
          <button
            type="button"
            className="qc-btn qc-primary"
            disabled={!day}
            onClick={() => onAvail(day)}
          >
            Xem máy trống
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="qc-step">
      <div className="qc-step-label">Lọc theo hạn sử dụng (tùy chọn):</div>
      <div className="qc-step-row">
        <DatePicker value={from} onChange={setFrom} placeholder="Từ ngày" />
        <span>→</span>
        <DatePicker value={to} onChange={setTo} placeholder="Đến ngày" />
      </div>
      <div className="qc-step-actions">
        <button
          type="button"
          className="qc-btn"
          onClick={() => onList(undefined, undefined)}
        >
          Bỏ qua
        </button>
        <button
          type="button"
          className="qc-btn qc-primary"
          onClick={() => onList(from || undefined, to || undefined)}
        >
          Lọc
        </button>
      </div>
    </div>
  );
}

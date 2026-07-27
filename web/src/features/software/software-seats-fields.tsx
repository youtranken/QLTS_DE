import { useTranslation } from 'react-i18next';
import { formatVnd, parseVnd } from '@/lib/asset-types';
import { DatePicker } from '@/ui/date-picker';

/** 1 bản (seat) khi TẠO phần mềm: mỗi bản có kỳ hạn + giá + ghi chú riêng (mua nhiều bản chung tên). */
export interface Seat {
  startDate: string;
  endDate: string;
  cost: string;
  note: string;
}

const nextDay = (d: string) =>
  new Date(new Date(d).getTime() + 86400000).toISOString().slice(0, 10);

/**
 * Nhập nhiều bản (seat) cùng license khi TẠO phần mềm — "Số bản" quyết định số dòng.
 * Mỗi dòng: Start / End (ẩn nếu vĩnh viễn) / Ghi chú riêng. Tất cả tạo ở trạng thái
 * "chưa gắn máy" — gán từng bản vào máy sau ở trang chi tiết license.
 */
export function SoftwareSeatsFields({
  seats,
  setSeats,
  isPerpetual,
  isTerm,
}: {
  seats: Seat[];
  setSeats: (updater: (prev: Seat[]) => Seat[]) => void;
  isPerpetual: boolean;
  isTerm: boolean;
}) {
  const { t } = useTranslation();

  const setQty = (raw: number) => {
    const q = Math.max(1, Math.min(200, Math.floor(raw || 1)));
    setSeats((prev) => {
      if (q === prev.length) return prev;
      if (q < prev.length) return prev.slice(0, q);
      const next = [...prev];
      while (next.length < q)
        next.push({ startDate: '', endDate: '', cost: '', note: '' });
      return next;
    });
  };

  const update = (i: number, key: keyof Seat, val: string) =>
    setSeats((prev) => prev.map((s, idx) => (idx === i ? { ...s, [key]: val } : s)));

  return (
    <div className="form-section">
      <div className="form-section-title">{t('software.seatsTitle')}</div>
      <label className="field" style={{ maxWidth: 200 }}>
        <span>{t('software.quantity')}</span>
        <input
          type="number"
          min={1}
          max={200}
          value={seats.length}
          onChange={(e) => setQty(Number(e.target.value))}
        />
      </label>
      <div className="table-wrap" style={{ marginTop: '0.6rem' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '3rem' }}>#</th>
              <th>{t('assets.startDate')}</th>
              {!isPerpetual && (
                <th>
                  {t('assets.endDate')}
                  {isTerm && <span className="field-req"> *</span>}
                </th>
              )}
              <th>{t('assets.cost')}</th>
              <th>{t('assets.note')}</th>
            </tr>
          </thead>
          <tbody>
            {seats.map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  <DatePicker
                    value={s.startDate}
                    max={s.endDate || undefined}
                    ariaLabel={t('assets.startDate')}
                    onChange={(v) => update(i, 'startDate', v)}
                  />
                </td>
                {!isPerpetual && (
                  <td>
                    <DatePicker
                      value={s.endDate}
                      min={s.startDate ? nextDay(s.startDate) : undefined}
                      ariaLabel={t('assets.endDate')}
                      onChange={(v) => update(i, 'endDate', v)}
                    />
                  </td>
                )}
                <td>
                  <input
                    type="text"
                    inputMode="numeric"
                    style={{ maxWidth: '9rem' }}
                    value={formatVnd(s.cost)}
                    onChange={(e) => update(i, 'cost', parseVnd(e.target.value))}
                  />
                </td>
                <td>
                  <input
                    maxLength={2000}
                    value={s.note}
                    onChange={(e) => update(i, 'note', e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

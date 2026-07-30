import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatVnd, parseVnd } from '@/lib/asset-types';
import { DatePicker } from '@/ui/date-picker';

/** 1 bản (seat) khi TẠO phần mềm: mỗi bản có kỳ hạn + giá + ghi chú riêng (mua nhiều bản chung tên). */
export interface Seat {
  startDate: string;
  endDate: string;
  cost: string;
  note: string;
  contract: string;
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

  // Ô "Số bản" giữ chuỗi RIÊNG (không bind thẳng seats.length): cho phép rỗng tạm khi
  // đang gõ. Nếu bind thẳng, xóa ô → Number('')=0 → clamp 1 → slice(0,1) XÓA mọi dòng
  // đã điền. Chỉ áp setQty khi là số ≥1; rỗng/sai → onBlur khôi phục theo seats.length.
  const [qtyStr, setQtyStr] = useState(String(seats.length));
  useEffect(() => {
    setQtyStr(String(seats.length));
  }, [seats.length]);

  // Mua nhiều bản cùng ngày/giá là ca phổ biến → mặc định "giống nhau": nhập MỘT lần, áp cho
  // tất cả. Bật/tắt để nhập riêng từng bản khi cần. (Giảm công nhập tay N dòng.)
  const [bulkSame, setBulkSame] = useState(true);
  const blank = (): Seat => ({
    startDate: '',
    endDate: '',
    cost: '',
    note: '',
    contract: '',
  });

  const setQty = (raw: number) => {
    const q = Math.max(1, Math.min(200, Math.floor(raw || 1)));
    setSeats((prev) => {
      if (q === prev.length) return prev;
      if (q < prev.length) return prev.slice(0, q);
      // "Giống nhau" → bản mới sao chép bản 1 (đỡ nhập lại); ngược lại thêm dòng trống.
      const tmpl = bulkSame && prev[0] ? prev[0] : null;
      const next = [...prev];
      while (next.length < q) next.push(tmpl ? { ...tmpl } : blank());
      return next;
    });
  };

  const update = (i: number, key: keyof Seat, val: string) =>
    setSeats((prev) => prev.map((s, idx) => (idx === i ? { ...s, [key]: val } : s)));

  // "Giống nhau": mọi thay đổi áp cho TẤT CẢ bản.
  const updateAll = (key: keyof Seat, val: string) =>
    setSeats((prev) => prev.map((s) => ({ ...s, [key]: val })));

  // Bật "giống nhau" → đồng bộ mọi bản theo bản 1 (đúng nghĩa "giống nhau").
  const toggleBulk = (on: boolean) => {
    setBulkSame(on);
    if (on) setSeats((prev) => (prev[0] ? prev.map(() => ({ ...prev[0] })) : prev));
  };

  const s0 = seats[0] ?? blank();

  // Ô nhập cho MỘT bản — dùng lại cho cả chế độ "giống nhau" (1 dòng, updateAll) lẫn "riêng"
  // (từng dòng, update theo index). onSet nhận (key, val).
  const seatCells = (
    s: Seat,
    onSet: (key: keyof Seat, val: string) => void,
  ) => (
    <>
      <td>
        <DatePicker
          value={s.startDate}
          max={s.endDate || undefined}
          ariaLabel={t('assets.startDate')}
          onChange={(v) => onSet('startDate', v)}
        />
      </td>
      {!isPerpetual && (
        <td>
          <DatePicker
            value={s.endDate}
            min={s.startDate ? nextDay(s.startDate) : undefined}
            ariaLabel={t('assets.endDate')}
            onChange={(v) => onSet('endDate', v)}
          />
        </td>
      )}
      <td>
        <input
          type="text"
          inputMode="numeric"
          style={{ maxWidth: '9rem' }}
          value={formatVnd(s.cost)}
          onChange={(e) => onSet('cost', parseVnd(e.target.value))}
        />
      </td>
      <td>
        <input
          maxLength={2000}
          value={s.contract}
          onChange={(e) => onSet('contract', e.target.value)}
        />
      </td>
      <td>
        <input
          maxLength={2000}
          value={s.note}
          onChange={(e) => onSet('note', e.target.value)}
        />
      </td>
    </>
  );

  return (
    <div className="form-section">
      <div className="form-section-title">{t('software.seatsTitle')}</div>
      <div
        style={{
          display: 'flex',
          gap: '1.25rem',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
        }}
      >
        <label className="field" style={{ maxWidth: 160 }}>
          <span>{t('software.quantity')}</span>
          <input
            type="number"
            min={1}
            max={200}
            value={qtyStr}
            onChange={(e) => {
              setQtyStr(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value !== '' && Number.isFinite(n) && n >= 1) setQty(n);
            }}
            onBlur={() => setQtyStr(String(seats.length))}
          />
        </label>
        <label
          className="field"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: '0.4rem',
            paddingBottom: '0.55rem',
          }}
        >
          <input
            type="checkbox"
            checked={bulkSame}
            onChange={(e) => toggleBulk(e.target.checked)}
          />
          <span>
            {t('software.seatsSame', 'Các bản giống nhau — nhập một lần')}
          </span>
        </label>
      </div>
      <div className="table-wrap" style={{ marginTop: '0.6rem' }}>
        <table className="table">
          <thead>
            <tr>
              {!bulkSame && <th style={{ width: '3rem' }}>#</th>}
              <th>{t('assets.startDate')}</th>
              {!isPerpetual && (
                <th>
                  {t('assets.endDate')}
                  {isTerm && <span className="field-req"> *</span>}
                </th>
              )}
              <th>{t('assets.cost')}</th>
              <th>{t('assets.contract', 'Contract')}</th>
              <th>{t('assets.note')}</th>
            </tr>
          </thead>
          <tbody>
            {bulkSame ? (
              <tr>{seatCells(s0, updateAll)}</tr>
            ) : (
              seats.map((s, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  {seatCells(s, (key, val) => update(i, key, val))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {bulkSame && seats.length > 1 && (
        <div className="hint" style={{ marginTop: '0.4rem', opacity: 0.7 }}>
          {t('software.seatsSameHint', {
            n: seats.length,
            defaultValue: 'Áp dụng cho cả {{n}} bản.',
          })}
        </div>
      )}
    </div>
  );
}

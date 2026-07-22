import type { Card } from './chat-types';

const STATUS: Record<string, { label: string; cls: string }> = {
  in_use: { label: 'Đang dùng', cls: 'ok' },
  locked_repair: { label: 'Sửa chữa', cls: 'warn' },
  disposed: { label: 'Thanh lý', cls: 'warn' },
  Trống: { label: 'Trống', cls: 'ok' },
};

/** Bảng kết quả nhúng — mã · loại · trạng thái; kèm người giữ/hạn/phần mềm; nút Đặt cho máy trống. */
export function ChatResultCard({
  cards,
  total,
  onSeeAll,
  onBook,
}: {
  cards: Card[];
  total?: number;
  onSeeAll?: () => void;
  onBook?: () => void;
}) {
  if (cards.length === 0) return null;
  const more = typeof total === 'number' && total > cards.length;
  return (
    <div className="qc-card">
      <table>
        <thead>
          <tr>
            <th>Mã</th>
            <th>Loại</th>
            <th>Trạng thái</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c, i) => {
            const st = STATUS[c.status] ?? { label: c.status, cls: 'ok' };
            const free = c.status === 'Trống';
            return (
              <tr key={c.code ?? i}>
                <td>
                  <span className="qc-code">{c.code ?? '—'}</span>
                  {c.holder && <div className="qc-sub">{c.holder}</div>}
                  {c.endDate && <div className="qc-sub">HĐ đến {c.endDate}</div>}
                </td>
                <td>{c.type}</td>
                <td>
                  {free && onBook ? (
                    <button type="button" className="qc-book" onClick={onBook}>
                      Đặt
                    </button>
                  ) : (
                    <span className={`qc-pill ${st.cls}`}>{st.label}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {more && onSeeAll && (
        <button type="button" className="qc-more" onClick={onSeeAll}>
          Xem đầy đủ {total} tài sản trong trang Tài sản →
        </button>
      )}
    </div>
  );
}

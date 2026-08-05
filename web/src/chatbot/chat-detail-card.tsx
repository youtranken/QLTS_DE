import type { AssetDetail } from '@/chatbot/chat-types';

const STATUS: Record<string, { label: string; cls: string }> = {
  in_use: { label: 'Đang dùng', cls: 'ok' },
  locked_repair: { label: 'Sửa chữa', cls: 'warn' },
  disposed: { label: 'Thanh lý', cls: 'warn' },
};

/** Chi tiết 1 máy: khối THIẾT BỊ (rows theo khía cạnh được hỏi) + khối PHẦN MỀM tách riêng. */
export function ChatDetailCard({ detail }: { detail: AssetDetail }) {
  const st = STATUS[detail.status] ?? { label: detail.status, cls: 'ok' };
  return (
    <div className="qc-detail">
      <div className="qc-detail-head">
        <span className="qc-code">{detail.code ?? '—'}</span>
        <span className="qc-detail-type">{detail.type}</span>
        <span className={`qc-pill ${st.cls}`}>{st.label}</span>
      </div>

      {detail.rows.length > 0 && (
        <div className="qc-detail-rows">
          {detail.rows.map((r, i) => (
            <div key={i} className="qc-detail-row">
              <span className="qc-dl">{r.label}</span>
              <span className="qc-dv">{r.value}</span>
            </div>
          ))}
        </div>
      )}

      {detail.software !== null && (
        <div className="qc-sw">
          <div className="qc-sw-head">💿 Phần mềm đã cài</div>
          {detail.software.length ? (
            <ul className="qc-sw-list">
              {detail.software.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ) : (
            <div className="qc-sw-empty">Máy chưa cài phần mềm nào.</div>
          )}
        </div>
      )}
    </div>
  );
}

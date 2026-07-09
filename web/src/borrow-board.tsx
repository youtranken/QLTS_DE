import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminDashboard } from './admin-dashboard';
import { BookingSheet } from './booking-sheet';
import { MyRequestsPanel } from './my-requests';
import type { Me } from './panels';

interface BoardRow {
  ticketId: string;
  assetCode: string | null;
  type: string | null;
  borrowerName: string | null;
  department: string | null;
  from: string | null;
  due: string | null;
  state: string;
  isOverdue: boolean;
  isMine: boolean;
  note: string | null;
  recurringCount: number | null;
}

const POLL_MS = 30_000;

const typeIcon = (type: string | null): string => {
  const ty = (type ?? '').toLowerCase();
  if (ty.includes('laptop')) return '💻';
  if (ty.includes('desktop') || ty.includes('pc')) return '🖥️';
  if (ty.includes('printer') || ty.includes('máy in')) return '🖨️';
  if (ty.includes('monitor') || ty.includes('màn')) return '🖥️';
  if (ty.includes('phone') || ty.includes('điện thoại')) return '📱';
  return '📦';
};

/**
 * Trang chủ Borrow Board (7.5) — bảng máy đang mượn realtime cho member + admin.
 * Member: full màn + nút Đặt máy/Request của tôi ở đây (không sidebar). Admin: + dải thẻ số.
 * Poll /booking/board 30s; dòng quá hạn đỏ; đặt xong flash dòng của mình.
 */
export function BorrowBoardPage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showMine, setShowMine] = useState(false);
  const [flash, setFlash] = useState(false);
  const [reloadMine, setReloadMine] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/booking/board');
      if (res.ok) setRows((await res.json()) as BoardRow[]);
      else if (res.status === 401) window.location.href = '/';
    } catch {
      /* giữ dữ liệu cũ khi mạng chập */
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const onBooked = useCallback(() => {
    setFlash(true);
    setReloadMine((n) => n + 1);
    void load();
    setTimeout(() => setFlash(false), 2500);
  }, [load]);

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
          timeZone: 'Asia/Ho_Chi_Minh',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  const countdown = (due: string | null): string => {
    if (!due) return '';
    const ms = new Date(due).getTime() - now;
    if (ms <= 0) return t('board.overdueBy', { d: fmtDur(-ms) });
    return t('board.dueIn', { d: fmtDur(ms) });
  };
  const fmtDur = (ms: number): string => {
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    if (d > 0) return `${d}${t('board.dUnit')} ${h}${t('board.hUnit')}`;
    if (h > 0) return `${h}${t('board.hUnit')} ${m % 60}${t('board.mUnit')}`;
    return `${m}${t('board.mUnit')}`;
  };

  return (
    <section>
      <div
        className="page-header"
        style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}
      >
        <h1>{t('board.title')}</h1>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="ghost sm"
          onClick={() => setShowMine((v) => !v)}
        >
          {t('board.myRequests')}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => setSheetOpen(true)}
        >
          {t('board.bookMachine')}
        </button>
      </div>

      {isAdmin && <AdminDashboard />}

      {showMine && <MyRequestsPanel me={me} reloadKey={reloadMine} />}

      {rows === null ? (
        <p className="muted">{t('board.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="empty">{t('board.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table board-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('board.colDevice')}</th>
                <th>{t('board.colBorrower')}</th>
                <th>{t('board.colFrom')}</th>
                <th>{t('board.colDue')}</th>
                <th>{t('board.colNote')}</th>
                <th>{t('board.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.ticketId}-${r.from ?? i}`}
                  className={`${r.isOverdue ? 'row-overdue' : ''}${
                    flash && r.isMine ? ' row-flash' : ''
                  }`}
                >
                  <td>{i + 1}</td>
                  <td>
                    <span style={{ marginRight: 6 }}>{typeIcon(r.type)}</span>
                    <span className="mono">{r.assetCode ?? '—'}</span>
                    <small className="muted" style={{ marginLeft: 6 }}>
                      {r.type ?? ''}
                    </small>
                    {r.recurringCount != null && (
                      <span className="badge muted" style={{ marginLeft: 6 }}>
                        {t('board.recurring', { n: r.recurringCount })}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.borrowerName ?? '—'}
                    {r.isMine && (
                      <span className="badge ok" style={{ marginLeft: 6 }}>
                        {t('board.you')}
                      </span>
                    )}
                    {r.department && (
                      <div className="muted" style={{ fontSize: '0.82rem' }}>
                        {r.department}
                      </div>
                    )}
                  </td>
                  <td>{fmt(r.from)}</td>
                  <td>
                    {fmt(r.due)}
                    <div
                      className={r.isOverdue ? 'text-danger' : 'muted'}
                      style={{ fontSize: '0.8rem' }}
                    >
                      {countdown(r.due)}
                    </div>
                  </td>
                  <td>{r.note ?? ''}</td>
                  <td>
                    <span
                      className={`badge ${r.isOverdue ? 'danger' : r.state === 'in_use' ? 'ok' : 'muted'}`}
                    >
                      {t(`board.state.${r.state}`, r.state)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sheetOpen && (
        <BookingSheet
          me={me}
          onClose={() => setSheetOpen(false)}
          onBooked={onBooked}
        />
      )}
    </section>
  );
}

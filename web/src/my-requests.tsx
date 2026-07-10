import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MemberRecurringSessions } from './member-recurring-sessions';
import type { Me } from './panels';

interface MyTicket {
  id: string;
  state: string;
  stateLabel: string;
  kind: string;
  version: number;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  createdAt: string;
  cancellable: boolean;
  isOverdue: boolean;
  overdueMinutes: number | null;
  extensionCount: number;
  hasPendingExtension: boolean;
  sessionCount: number;
}

/** "Request của tôi" (3.3) — dưới form đặt máy. Nút Hủy chỉ hiện khi cancellable. */
export function MyRequestsPanel({
  me,
  reloadKey,
}: {
  me: Me;
  reloadKey: number;
}) {
  const { t, i18n } = useTranslation();
  const [tickets, setTickets] = useState<MyTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 4.5b: mở rộng xem từng buổi của chuỗi định kỳ
  const [openSessions, setOpenSessions] = useState<string | null>(null);
  // 4.1: modal xin gia hạn
  const [extTicket, setExtTicket] = useState<MyTicket | null>(null);
  const [newDue, setNewDue] = useState('');
  const [extBusy, setExtBusy] = useState(false);
  const [extErr, setExtErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/booking/my-tickets');
      if (res.ok) {
        setTickets((await res.json()) as MyTicket[]);
        return;
      }
      setError(t('myreq.error'));
    } catch {
      setError(t('myreq.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const cancel = useCallback(
    async (ticket: MyTicket) => {
      if (!window.confirm(t('myreq.confirmCancel'))) return;
      setBusyId(ticket.id);
      setError(null);
      try {
        const res = await fetch(
          `/api/booking/my-tickets/${ticket.id}/cancel`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({ version: ticket.version }),
          },
        );
        if (res.ok) {
          await load();
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        const map: Record<string, string> = {
          STALE_VERSION: t('myreq.errStale'),
          CANNOT_CANCEL: t('myreq.errCannotCancel'),
          NOT_TICKET_OWNER: t('myreq.errNotOwner'),
        };
        // reload TRƯỚC (load reset error=null) rồi mới set message — không bị nuốt
        await load();
        setError((body.code && map[body.code]) || t('myreq.error'));
      } catch {
        setError(t('myreq.error'));
      } finally {
        setBusyId(null);
      }
    },
    [me.csrfToken, load, t],
  );

  const submitExtension = useCallback(async () => {
    if (!extTicket || !newDue) return;
    setExtBusy(true);
    setExtErr(null);
    try {
      const res = await fetch(
        `/api/booking/my-tickets/${extTicket.id}/extension`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({
            newDue: new Date(newDue).toISOString(),
            version: extTicket.version,
          }),
        },
      );
      if (res.status === 201 || res.ok) {
        setExtTicket(null);
        setNewDue('');
        await load();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      const map: Record<string, string> = {
        SLOT_TAKEN: t('extension.errSlot'),
        ASSET_UNAVAILABLE: t('extension.errSlot'),
        EXTENSION_TOO_LONG: t('extension.errTooLong'),
        EXTENSION_LIMIT: t('extension.errLimit'),
        EXTENSION_PENDING: t('extension.errPending'),
        TICKET_OVERDUE: t('extension.errOverdue'),
        INVALID_RANGE: t('extension.errRange'),
        STALE_VERSION: t('extension.errStale'),
      };
      setExtErr((body.code && map[body.code]) || t('extension.errGeneric'));
      // 409 khung bị nẫng → refetch danh sách (convention); modal vẫn mở để chọn lại
      if (body.code === 'SLOT_TAKEN' || body.code === 'ASSET_UNAVAILABLE') {
        await load();
      }
    } catch {
      setExtErr(t('extension.errGeneric'));
    } finally {
      setExtBusy(false);
    }
  }, [extTicket, newDue, me.csrfToken, load, t]);

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(
          i18n.language === 'vi' ? 'vi-VN' : 'en-US',
          {
            timeZone: 'Asia/Ho_Chi_Minh',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          },
        )
      : '—';

  const stateBadge: Record<string, string> = {
    pending_approval: 'muted',
    awaiting_pickup: 'warn',
    in_use: 'ok',
    closed: 'muted',
    rejected: 'danger',
    cancelled: 'muted',
  };

  // Pipeline 4 bước: Chờ duyệt → Chờ giao → Đang mượn → Đã trả.
  // ≤2 ngày tự duyệt vào thẳng awaiting_pickup → bước "Chờ duyệt" vẫn tính done.
  // Trạng thái terminal (rejected/cancelled) không nằm trong map → không vẽ pipeline.
  const pipeSteps = [
    t('myreq.step1', 'Chờ duyệt'),
    t('myreq.step2', 'Chờ giao'),
    t('myreq.step3', 'Đang mượn'),
    t('myreq.step4', 'Đã trả'),
  ];
  const stepIndex: Record<string, number> = {
    pending_approval: 0,
    awaiting_pickup: 1,
    in_use: 2,
    returned: 3,
    closed: 3,
  };
  const renderPipe = (state: string) => {
    const cur = stepIndex[state];
    if (cur === undefined) return null;
    return (
      <div className="pipe" style={{ marginTop: 8 }}>
        {pipeSteps.map((label, i) => (
          <Fragment key={label}>
            {i > 0 && (
              <div className={`pbar${i <= cur ? ' done' : ''}`} />
            )}
            <div
              className={`pnode${
                i < cur ? ' done' : i === cur ? ' cur' : ''
              }`}
            >
              <div className="pc">
                {i < cur ? '✓' : i === cur ? '●' : ''}
              </div>
              <div className="plb">{label}</div>
            </div>
          </Fragment>
        ))}
      </div>
    );
  };

  return (
    <section style={{ marginTop: '2rem' }}>
      <h2>{t('myreq.title')}</h2>
      {error && <p className="alert error">{error}</p>}
      {tickets === null && <p>{t('myreq.loading')}</p>}
      {tickets !== null && tickets.length === 0 && (
        <p className="empty">{t('myreq.empty')}</p>
      )}
      {tickets !== null && tickets.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['colMachine', 'colTime', 'colState'].map((k) => (
                  <th key={k}>{t(`myreq.${k}`)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {tickets.map((tk) => (
                <Fragment key={tk.id}>
                <tr
                  className={
                    tk.state === 'in_use' && tk.isOverdue ? 'overdue' : undefined
                  }
                >
                  <td>
                    {tk.kind === 'recurring' && tk.sessionCount > 0 && (
                      <button
                        type="button"
                        className="link session-toggle"
                        aria-expanded={openSessions === tk.id}
                        onClick={() =>
                          setOpenSessions(openSessions === tk.id ? null : tk.id)
                        }
                      >
                        {openSessions === tk.id ? '▾' : '▸'}{' '}
                        {t('myreq.sessCount', { n: tk.sessionCount })}
                      </button>
                    )}
                    {tk.assetCode ? (
                      <span className="mono">{tk.assetCode}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {fmt(tk.from)} → {fmt(tk.to)}
                  </td>
                  <td>
                    <span className={`badge ${stateBadge[tk.state] ?? 'muted'}`}>
                      {tk.stateLabel}
                    </span>
                    {tk.hasPendingExtension && (
                      <span className="badge warn" style={{ marginLeft: 6 }}>
                        {t('extension.pendingChip')}
                      </span>
                    )}
                    {tk.isOverdue && (
                      <span
                        style={{
                          marginLeft: 6,
                          padding: '1px 6px',
                          borderRadius: 3,
                          background: '#c0392b',
                          color: '#fff',
                          fontSize: '0.75rem',
                        }}
                      >
                        {t('myreq.overdue', {
                          h: Math.floor((tk.overdueMinutes ?? 0) / 60),
                          m: (tk.overdueMinutes ?? 0) % 60,
                        })}
                      </span>
                    )}
                    {renderPipe(tk.state)}
                  </td>
                  <td className="table-actions">
                    {tk.cancellable && (
                      <button
                        type="button"
                        className="danger sm"
                        disabled={busyId !== null}
                        onClick={() => void cancel(tk)}
                      >
                        {busyId === tk.id
                          ? t('myreq.cancelling')
                          : t('myreq.cancel')}
                      </button>
                    )}
                    {tk.state === 'in_use' &&
                      !tk.isOverdue &&
                      tk.kind !== 'recurring' && (
                      <button
                        type="button"
                        className="sm"
                        disabled={tk.hasPendingExtension}
                        title={
                          tk.hasPendingExtension
                            ? t('extension.pendingHint')
                            : undefined
                        }
                        onClick={() => {
                          setExtErr(null);
                          setNewDue('');
                          setExtTicket(tk);
                        }}
                      >
                        {t('extension.action')}
                      </button>
                    )}
                  </td>
                </tr>
                {openSessions === tk.id && (
                  <MemberRecurringSessions
                    me={me}
                    ticketId={tk.id}
                    colSpan={4}
                    onChanged={() => void load()}
                  />
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 4.1: modal xin gia hạn (EXPERIENCE.md P1) */}
      {extTicket && (
        <div className="modal-backdrop" onClick={() => setExtTicket(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: '0.75rem' }}>
              {t('extension.title')}{' '}
              <span className="mono">{extTicket.assetCode}</span>
            </h2>
            <p className="muted" style={{ marginBottom: '0.75rem' }}>
              {t('extension.currentDue')}: <strong>{fmt(extTicket.to)}</strong>
              {' · '}
              {t('extension.usedCount', { n: extTicket.extensionCount })}
            </p>
            {extErr && <p className="alert error">{extErr}</p>}
            <label className="field" style={{ marginBottom: '1.25rem' }}>
              {t('extension.newDue')}
              <input
                type="datetime-local"
                value={newDue}
                onChange={(e) => setNewDue(e.target.value)}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setExtTicket(null)}>
                {t('extension.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={extBusy || !newDue}
                onClick={() => void submitExtension()}
              >
                {extBusy ? t('extension.submitting') : t('extension.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

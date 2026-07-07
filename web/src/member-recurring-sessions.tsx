import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

interface Session {
  id: string;
  version: number;
  state: string;
  stateLabel: string;
  from: string | null;
  to: string | null;
  isOverdue: boolean;
  cancellable: boolean;
}

const sessionBadge: Record<string, string> = {
  held: 'muted',
  pending: 'warn',
  delivered: 'ok',
  returned: 'muted',
  cancelled: 'danger',
};

/** 4.5b/4.6 — chi tiết từng buổi của chuỗi, mở rộng dưới dòng cha. Tự fetch; hủy buổi lẻ (4.6). */
export function MemberRecurringSessions({
  me,
  ticketId,
  colSpan,
  onChanged,
}: {
  me: Me;
  ticketId: string;
  colSpan: number;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/booking/my-tickets/${ticketId}/sessions`);
      if (res.ok) setSessions((await res.json()) as Session[]);
      else setError(t('myreq.sessErr'));
    } catch {
      setError(t('myreq.sessErr'));
    }
  }, [ticketId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = useCallback(
    async (s: Session) => {
      if (!window.confirm(t('myreq.sessConfirmCancel'))) return;
      setBusyId(s.id);
      try {
        const res = await fetch(`/api/booking/sessions/${s.id}/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({ version: s.version }),
        });
        await load();
        // buổi cuối bị hủy → state cha đổi (closed/cancelled) → refresh danh sách cha
        if (res.ok) {
          onChanged();
        } else {
          const body = (await res.json().catch(() => ({}))) as { code?: string };
          const map: Record<string, string> = {
            STALE_VERSION: t('myreq.errStale'),
            PICKUP_PASSED: t('myreq.sessErrPickup'),
            CANNOT_CANCEL_SESSION: t('myreq.sessErrDelivered'),
            NOT_TICKET_OWNER: t('myreq.errNotOwner'),
          };
          setError((body.code && map[body.code]) || t('myreq.sessErr'));
        }
      } catch {
        setError(t('myreq.sessErr'));
      } finally {
        setBusyId(null);
      }
    },
    [me.csrfToken, load, onChanged, t],
  );

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

  return (
    <tr className="session-detail-row">
      <td colSpan={colSpan} style={{ padding: 0 }}>
        {error && <p className="alert error">{error}</p>}
        {!error && sessions === null && (
          <p className="muted" style={{ padding: '0.5rem 1rem' }}>
            {t('myreq.loading')}
          </p>
        )}
        {sessions !== null && (
          <ol className="session-list">
            {sessions.map((s, i) => (
              <li key={s.id}>
                <span className="session-idx">{i + 1}</span>
                <span className="session-time">
                  {fmt(s.from)} → {fmt(s.to)}
                </span>
                <span className={`badge ${sessionBadge[s.state] ?? 'muted'}`}>
                  {s.stateLabel}
                </span>
                {s.isOverdue && (
                  <span className="badge danger">{t('myreq.sessOverdue')}</span>
                )}
                {s.cancellable && (
                  <button
                    type="button"
                    className="danger sm"
                    disabled={busyId !== null}
                    onClick={() => void cancel(s)}
                  >
                    {busyId === s.id
                      ? t('myreq.cancelling')
                      : t('myreq.sessCancel')}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </td>
    </tr>
  );
}

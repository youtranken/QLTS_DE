import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
        setError((body.code && map[body.code]) || t('myreq.error'));
        await load(); // đồng bộ lại trạng thái thật (STALE/đổi trạng thái)
      } catch {
        setError(t('myreq.error'));
      } finally {
        setBusyId(null);
      }
    },
    [me.csrfToken, load, t],
  );

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

  return (
    <section style={{ maxWidth: 900, marginTop: '2rem' }}>
      <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>
        {t('myreq.title')}
      </h2>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {tickets === null && <p>{t('myreq.loading')}</p>}
      {tickets !== null && tickets.length === 0 && <p>{t('myreq.empty')}</p>}
      {tickets !== null && tickets.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {['colMachine', 'colTime', 'colState'].map((k) => (
                  <th
                    key={k}
                    style={{
                      textAlign: 'left',
                      borderBottom: '1px solid #ccc',
                      padding: '0.4rem',
                    }}
                  >
                    {t(`myreq.${k}`)}
                  </th>
                ))}
                <th style={{ borderBottom: '1px solid #ccc' }} />
              </tr>
            </thead>
            <tbody>
              {tickets.map((tk) => (
                <tr key={tk.id}>
                  <td style={{ padding: '0.4rem' }}>{tk.assetCode ?? '—'}</td>
                  <td style={{ padding: '0.4rem' }}>
                    {fmt(tk.from)} → {fmt(tk.to)}
                  </td>
                  <td style={{ padding: '0.4rem' }}>{tk.stateLabel}</td>
                  <td style={{ padding: '0.4rem' }}>
                    {tk.cancellable && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void cancel(tk)}
                      >
                        {busyId === tk.id
                          ? t('myreq.cancelling')
                          : t('myreq.cancel')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

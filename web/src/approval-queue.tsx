import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

interface PendingRequest {
  id: string;
  version: number;
  borrowerSub: string;
  borrowerName: string | null;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  createdAt: string;
}

/** Hàng đợi Admin duyệt/từ chối request >48h (3.4). */
export function ApprovalQueuePage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<PendingRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/tickets/pending-approval');
      if (res.ok) {
        setItems((await res.json()) as PendingRequest[]);
        return;
      }
      setError(t('approval.error'));
    } catch {
      setError(t('approval.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (
      req: PendingRequest,
      kind: 'approve' | 'reject',
      rejectReason?: string,
    ) => {
      setBusyId(req.id);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/tickets/${req.id}/${kind}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify(
              kind === 'reject'
                ? { version: req.version, reason: rejectReason }
                : { version: req.version },
            ),
          },
        );
        if (res.ok) {
          setRejectingId(null);
          setReason('');
          await load();
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        const map: Record<string, string> = {
          STALE_VERSION: t('approval.errStale'),
          INVALID_STATE: t('approval.errInvalidState'),
          PICKUP_PASSED: t('approval.errPickupPassed'),
        };
        // load() reset error=null → phải reload TRƯỚC rồi mới set message (không bị nuốt)
        await load();
        setError((body.code && map[body.code]) || t('approval.error'));
      } catch {
        setError(t('approval.error'));
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
    <section style={{ maxWidth: 950 }}>
      <h1 style={{ fontSize: '1.2rem', marginBottom: '1rem' }}>
        {t('approval.title')}
      </h1>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {items === null && <p>{t('approval.loading')}</p>}
      {items !== null && items.length === 0 && <p>{t('approval.empty')}</p>}
      {items !== null && items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {['colBorrower', 'colMachine', 'colTime'].map((k) => (
                  <th
                    key={k}
                    style={{
                      textAlign: 'left',
                      borderBottom: '1px solid #ccc',
                      padding: '0.4rem',
                    }}
                  >
                    {t(`approval.${k}`)}
                  </th>
                ))}
                <th style={{ borderBottom: '1px solid #ccc' }} />
              </tr>
            </thead>
            <tbody>
              {items.map((req) => (
                <tr key={req.id}>
                  <td style={{ padding: '0.4rem' }}>
                    {req.borrowerName ?? req.borrowerSub}
                  </td>
                  <td style={{ padding: '0.4rem' }}>{req.assetCode ?? '—'}</td>
                  <td style={{ padding: '0.4rem' }}>
                    {fmt(req.from)} → {fmt(req.to)}
                  </td>
                  <td style={{ padding: '0.4rem', whiteSpace: 'nowrap' }}>
                    {rejectingId === req.id ? (
                      <span
                        style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                      >
                        <input
                          value={reason}
                          placeholder={t('approval.reasonPlaceholder')}
                          onChange={(e) => setReason(e.target.value)}
                          style={{ minWidth: 180 }}
                        />
                        <button
                          type="button"
                          disabled={busyId !== null || reason.trim() === ''}
                          onClick={() => void act(req, 'reject', reason.trim())}
                        >
                          {t('approval.confirmReject')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingId(null);
                            setReason('');
                          }}
                        >
                          {t('approval.cancel')}
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void act(req, 'approve')}
                        >
                          {t('approval.approve')}
                        </button>{' '}
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => {
                            setRejectingId(req.id);
                            setReason('');
                          }}
                        >
                          {t('approval.reject')}
                        </button>
                      </>
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

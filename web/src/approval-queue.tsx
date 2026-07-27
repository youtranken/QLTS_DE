import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from '@/lib/me';
import { RecurringSessionQueue } from '@/recurring-session-queue';
import { ExtensionQueue } from '@/extension-queue';
import { HandoverQueues } from '@/handover-queues';

interface PendingRequest {
  id: string;
  version: number;
  kind: string;
  borrowerSub: string;
  borrowerName: string | null;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  sessionCount: number;
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
  // Đếm số cho dải summary chips — lấy từ dữ liệu các queue con báo lên (không fetch thêm)
  const [extCount, setExtCount] = useState(0);
  const [hoCounts, setHoCounts] = useState({ pickup: 0, inUse: 0, overdue: 0 });

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
        // 4.5a: chuỗi định kỳ duyệt/từ chối CẢ chuỗi qua route recurring/*
        const path =
          req.kind === 'recurring'
            ? `/api/admin/tickets/recurring/${req.id}/${kind}`
            : `/api/admin/tickets/${req.id}/${kind}`;
        const res = await fetch(
          path,
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
    <section>
      <div className="page-header">
        <h1>{t('approval.title')}</h1>
      </div>
      <div className="stat-grid stat-grid-5" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className={`stat-num${(items?.length ?? 0) === 0 ? ' zero' : ''}`}>
            {items?.length ?? 0}
          </div>
          <div className="stat-label">{t('approval.kpiPending', 'Chờ duyệt')}</div>
        </div>
        <div className="stat-card">
          <div className={`stat-num${hoCounts.pickup === 0 ? ' zero' : ''}`}>
            {hoCounts.pickup}
          </div>
          <div className="stat-label">{t('handover.kpiPickup', 'Chờ giao')}</div>
        </div>
        <div className="stat-card">
          <div className={`stat-num${hoCounts.inUse === 0 ? ' zero' : ''}`}>
            {hoCounts.inUse}
          </div>
          <div className="stat-label">{t('handover.kpiInUse', 'Chờ nhận')}</div>
        </div>
        <div className="stat-card">
          <div className={`stat-num${extCount === 0 ? ' zero' : ''}`}>
            {extCount}
          </div>
          <div className="stat-label">{t('extapprove.kpiExt', 'Gia hạn')}</div>
        </div>
        <div className={hoCounts.overdue > 0 ? 'stat-card critical' : 'stat-card'}>
          <div className={`stat-num${hoCounts.overdue === 0 ? ' zero' : ''}`}>
            {hoCounts.overdue}
          </div>
          <div className="stat-label">{t('handover.kpiOverdue', 'Quá hạn')}</div>
        </div>
      </div>
      {error && <p className="alert error">{error}</p>}
      {items === null && <p>{t('approval.loading')}</p>}
      {items !== null && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['colBorrower', 'colMachine', 'colTime'].map((k) => (
                  <th key={k}>{t(`approval.${k}`)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    {t('approval.empty')}
                  </td>
                </tr>
              )}
              {items.map((req) => (
                <tr key={req.id}>
                  <td>{req.borrowerName ?? req.borrowerSub}</td>
                  <td>
                    {req.assetCode ? (
                      <span className="mono">{req.assetCode}</span>
                    ) : (
                      '—'
                    )}
                    {req.kind === 'recurring' && (
                      <span className="badge muted" style={{ marginLeft: 6 }}>
                        {t('approval.recurringChip', { n: req.sessionCount })}
                      </span>
                    )}
                  </td>
                  <td>
                    {fmt(req.from)} → {fmt(req.to)}
                    {req.kind === 'recurring' && (
                      <span className="muted"> {t('approval.recurringFirst')}</span>
                    )}
                  </td>
                  <td className="table-actions">
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
                          className="danger sm"
                          disabled={busyId !== null || reason.trim() === ''}
                          onClick={() => void act(req, 'reject', reason.trim())}
                        >
                          {t('approval.confirmReject')}
                        </button>
                        <button
                          type="button"
                          className="sm"
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
                          className="primary sm"
                          disabled={busyId !== null}
                          onClick={() => void act(req, 'approve')}
                        >
                          {t('approval.approve')}
                        </button>{' '}
                        <button
                          type="button"
                          className="danger sm"
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

      <ExtensionQueue me={me} onCount={setExtCount} />
      <HandoverQueues me={me} onCounts={setHoCounts} />
      <RecurringSessionQueue me={me} />
    </section>
  );
}

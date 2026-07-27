import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from '@/lib/me';

interface ExtensionRow {
  extensionId: string;
  version: number;
  borrowerName: string | null;
  assetCode: string | null;
  oldDue: string | null;
  newDue: string | null;
  usedCount: number;
}

/** Hàng đợi Chờ gia hạn (4.2) — duyệt/từ chối, đọc kết cục qua result (AD-16). */
export function ExtensionQueue({
  me,
  onCount,
}: {
  me: Me;
  onCount?: (n: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<ExtensionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/tickets/extensions');
      if (res.ok) setRows((await res.json()) as ExtensionRow[]);
    } catch {
      setError(t('extapprove.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onCount?.(rows.length);
  }, [rows.length, onCount]);

  const act = useCallback(
    async (row: ExtensionRow, kind: 'approve' | 'reject', rej?: string) => {
      setBusyId(row.extensionId);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/tickets/extensions/${row.extensionId}/${kind}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify(
              kind === 'reject'
                ? { version: row.version, reason: rej }
                : { version: row.version },
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
          STALE_VERSION: t('extapprove.errStale'),
          EXTENSION_EXPIRED: t('extapprove.errExpired'),
          INVALID_STATE: t('extapprove.errState'),
        };
        await load();
        setError((body.code && map[body.code]) || t('extapprove.error'));
      } catch {
        setError(t('extapprove.error'));
      } finally {
        setBusyId(null);
      }
    },
    [me.csrfToken, load, t],
  );

  const fmt = (isoStr: string | null) =>
    isoStr
      ? new Date(isoStr).toLocaleString(
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

  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1.05rem', marginBottom: '0.5rem' }}>
        {t('extapprove.title')}
      </h2>
      {error && <p className="alert error">{error}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('extapprove.colBorrower')}</th>
              <th>{t('extapprove.colMachine')}</th>
              <th>{t('extapprove.colDue')}</th>
              <th>{t('extapprove.colUsed')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.extensionId}>
                <td>{row.borrowerName ?? '—'}</td>
                <td>
                  <span className="mono">{row.assetCode ?? '—'}</span>
                </td>
                <td>
                  {fmt(row.oldDue)} → {fmt(row.newDue)}
                </td>
                <td>{row.usedCount}</td>
                <td className="table-actions">
                  {rejectingId === row.extensionId ? (
                    <span
                      style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                    >
                      <input
                        value={reason}
                        placeholder={t('extapprove.reasonPlaceholder')}
                        onChange={(e) => setReason(e.target.value)}
                        style={{ minWidth: 160 }}
                      />
                      <button
                        type="button"
                        className="danger sm"
                        disabled={busyId !== null || reason.trim() === ''}
                        onClick={() => void act(row, 'reject', reason.trim())}
                      >
                        {t('extapprove.confirmReject')}
                      </button>
                      <button
                        type="button"
                        className="sm"
                        onClick={() => {
                          setRejectingId(null);
                          setReason('');
                        }}
                      >
                        {t('extapprove.cancel')}
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary sm"
                        disabled={busyId !== null}
                        onClick={() => void act(row, 'approve')}
                      >
                        {t('extapprove.approve')}
                      </button>{' '}
                      <button
                        type="button"
                        className="danger sm"
                        disabled={busyId !== null}
                        onClick={() => {
                          setRejectingId(row.extensionId);
                          setReason('');
                        }}
                      >
                        {t('extapprove.reject')}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

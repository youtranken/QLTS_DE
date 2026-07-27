import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchJson } from '@/fetch-json';
import { LoadError } from '@/load-state';

interface Alert {
  sub: string;
  fullName: string | null;
  status: string;
  ticketCount: number;
  assetCount: number;
}
interface NeedsMatch {
  id: string;
  code: string;
  importedUserText: string | null;
}
interface Queue {
  total: number;
  alerts: Alert[];
  needsMatch: NeedsMatch[];
}

/**
 * Hàng đợi "cảnh báo nghỉ việc" (5.5) — user SSO disable còn ticket/đứng tên tài sản; mục "cần
 * đối chiếu" (import không khớp SSO) tách RIÊNG. Derive từ status hiện tại → active lại thì rời.
 */
export function OffboardingQueuePage() {
  const { t } = useTranslation();
  const [data, setData] = useState<Queue | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(false);
    fetchJson<Queue>('/api/admin/offboarding')
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const statusText = (s: string) =>
    s === 'deleted' ? t('offboard.deleted') : t('offboard.locked');

  return (
    <section>
      <div className="page-header">
        <h1>{t('offboard.title')}</h1>
      </div>
      {error ? (
        <LoadError onRetry={() => setReloadKey((k) => k + 1)} />
      ) : data === null ? (
        <p className="muted">…</p>
      ) : (
        <>
          <h2>{t('offboard.alertsHeading')}</h2>
          {data.alerts.length === 0 ? (
            <p className="muted">{t('offboard.noAlerts')}</p>
          ) : (
            <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('offboard.name')}</th>
                  <th>{t('offboard.status')}</th>
                  <th>{t('offboard.ticketCount')}</th>
                  <th>{t('offboard.assetCount')}</th>
                </tr>
              </thead>
              <tbody>
                {data.alerts.map((a) => (
                  <tr key={a.sub}>
                    <td>{a.fullName ?? a.sub}</td>
                    <td style={{ color: 'var(--danger)' }}>
                      {statusText(a.status)}
                    </td>
                    <td>{a.ticketCount}</td>
                    <td>{a.assetCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}

          <h2 style={{ marginTop: '1.5rem' }}>
            {t('offboard.needsMatchHeading')}
          </h2>
          {data.needsMatch.length === 0 ? (
            <p className="muted">{t('offboard.noNeedsMatch')}</p>
          ) : (
            <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('offboard.assetCode')}</th>
                  <th>{t('offboard.importedUser')}</th>
                </tr>
              </thead>
              <tbody>
                {data.needsMatch.map((m) => (
                  <tr key={m.id}>
                    <td>{m.code}</td>
                    <td>{m.importedUserText ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

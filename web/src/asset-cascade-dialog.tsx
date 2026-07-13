import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDateTime } from './asset-types';
import type { LifecycleRun, PendingCascade } from './asset-types';

/**
 * Popup xác nhận cascade (3.13) — danh sách booking bị hủy/thu hồi + cờ báo mail, khi Gỡ pool/Thanh lý.
 * Tách khỏi asset-form (§6). Presentational: cascade state + doLifecycle vẫn ở asset-form.
 */
export function AssetCascadeDialog({
  cascade,
  setCascade,
  notifyUsers,
  setNotifyUsers,
  busy,
  doLifecycle,
}: {
  cascade: PendingCascade;
  setCascade: Dispatch<SetStateAction<PendingCascade | null>>;
  notifyUsers: boolean;
  setNotifyUsers: (v: boolean) => void;
  busy: boolean;
  doLifecycle: LifecycleRun;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="modal-backdrop stacked"
      onClick={(e) => {
        e.stopPropagation();
        setCascade(null);
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: '0.75rem' }}>{t('cascade.title')}</h2>

        {cascade.data.futureCancellations.length > 0 && (
          <div style={{ marginBottom: '1rem' }}>
            <h3 style={{ marginBottom: '0.4rem' }}>
              {t('cascade.willCancel', {
                n: cascade.data.futureCancellations.length,
              })}
            </h3>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('cascade.colBorrower')}</th>
                    <th>{t('cascade.colTime')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cascade.data.futureCancellations.map((r) => (
                    // key kèm from: ticket recurring (Epic 4) có nhiều booking/máy → tránh trùng key
                    <tr key={`${r.ticketId}-${r.from ?? ''}`}>
                      <td>{r.borrowerName ?? '—'}</td>
                      <td>
                        {fmtDateTime(r.from)} → {fmtDateTime(r.to)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {cascade.data.inUseRecalls.length > 0 && (
          <div style={{ marginBottom: '1rem' }}>
            <h3 style={{ marginBottom: '0.4rem' }}>
              {t('cascade.willRecall', {
                n: cascade.data.inUseRecalls.length,
              })}
            </h3>
            <p
              className="muted"
              style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}
            >
              {t('cascade.recallHint')}
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('cascade.colBorrower')}</th>
                    <th>{t('cascade.colTime')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cascade.data.inUseRecalls.map((r) => (
                    <tr key={`${r.ticketId}-${r.from ?? ''}`}>
                      <td>{r.borrowerName ?? '—'}</td>
                      <td>
                        {fmtDateTime(r.from)} → {fmtDateTime(r.to)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            margin: '0.75rem 0 1.25rem',
          }}
        >
          <input
            type="checkbox"
            checked={notifyUsers}
            onChange={(e) => setNotifyUsers(e.target.checked)}
            style={{ width: 'auto' }}
          />
          {t('cascade.notify')}
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => setCascade(null)}>
            {t('cascade.cancel')}
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              const c = cascade;
              setCascade(null);
              void doLifecycle(
                c.path,
                c.method,
                { ...c.extra, notify: notifyUsers },
                c.patch,
              );
            }}
          >
            {t('cascade.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

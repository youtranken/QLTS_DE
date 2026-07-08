import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

interface FailedItem {
  id: string;
  topic: string;
  failCount: number;
  lastError: string | null;
  lastFailedAt: string | null;
}

/**
 * Danh sách "thông báo gửi lỗi" (5.1, AD-11) — Admin/SA xem event cạn retry + requeue tay.
 * Requeue = cắt về backlog để relay re-drive (không gọi SMTP trực tiếp trong request path).
 */
export function NotificationsFailedPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<FailedItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/notifications/failed');
    const data = (r.ok ? await r.json() : { items: [] }) as {
      items: FailedItem[];
    };
    setItems(data.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const requeue = useCallback(
    async (id: string) => {
      setBusy(id);
      setErr(null);
      try {
        const r = await fetch(`/api/admin/notifications/${id}/requeue`, {
          method: 'POST',
          headers: me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {},
        });
        if (!r.ok) {
          setErr(t('notifyFailed.retryError'));
          return;
        }
        await load();
      } finally {
        setBusy(null);
      }
    },
    [me.csrfToken, load, t],
  );

  return (
    <section>
      <div className="page-header">
        <h1>{t('notifyFailed.title')}</h1>
      </div>
      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
      {items === null ? (
        <p className="muted">…</p>
      ) : items.length === 0 ? (
        <p className="muted">{t('notifyFailed.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('notifyFailed.topic')}</th>
              <th>{t('notifyFailed.failCount')}</th>
              <th>{t('notifyFailed.lastError')}</th>
              <th>{t('notifyFailed.lastFailedAt')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>{it.topic}</td>
                <td>{it.failCount}</td>
                <td style={{ color: 'var(--danger)' }}>{it.lastError ?? '—'}</td>
                <td>
                  {it.lastFailedAt
                    ? new Date(it.lastFailedAt).toLocaleString()
                    : '—'}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === it.id}
                    onClick={() => void requeue(it.id)}
                  >
                    {t('notifyFailed.retry')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

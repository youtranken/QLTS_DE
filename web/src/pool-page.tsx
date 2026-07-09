import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

interface PoolItem {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
  brand: string | null;
  status: string;
  version: number;
  assignedUserName: string | null;
}

/**
 * Pool máy cho mượn (8.4): admin thêm máy vào pool bằng MTS (mã tài sản) — thông tin kéo từ QLTS.
 * Đây là nguồn máy member thấy khi Đặt máy (availability lọc is_pool + in_use). Gỡ khỏi pool
 * dùng endpoint pool sẵn có (cascade hủy booking tương lai + báo mail).
 */
export function PoolPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PoolItem[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const headers = useMemo(
    () => ({
      'Content-Type': 'application/json',
      ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
    }),
    [me.csrfToken],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/pool');
      if (res.ok) setItems((await res.json()) as PoolItem[]);
      else setError(t('pool.loadFailed'));
    } catch {
      setError(t('pool.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch('/api/admin/pool', {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: c }),
      });
      if (res.ok || res.status === 201) {
        setCode('');
        setOk(t('pool.added', { code: c }));
        await load();
      } else {
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        setError(b.message ?? t('pool.addFailed'));
      }
    } catch {
      setError(t('pool.addFailed'));
    } finally {
      setBusy(false);
    }
  }, [code, headers, load, t]);

  const remove = useCallback(
    async (it: PoolItem) => {
      if (!window.confirm(t('pool.removeConfirm', { code: it.code }))) return;
      setBusy(true);
      setError(null);
      setOk(null);
      try {
        // Gỡ pool = cascade hủy booking tương lai + báo mail (endpoint vòng đời sẵn có).
        const res = await fetch(`/api/admin/assets/${it.id}/pool`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ isPool: false, version: it.version, notify: true }),
        });
        if (res.ok) {
          setOk(t('pool.removed', { code: it.code }));
          await load();
        } else if (res.status === 409) {
          setError(t('pool.stale'));
          await load();
        } else {
          const b = (await res.json().catch(() => ({}))) as { message?: string };
          setError(b.message ?? t('pool.removeFailed'));
        }
      } catch {
        setError(t('pool.removeFailed'));
      } finally {
        setBusy(false);
      }
    },
    [headers, load, t],
  );

  return (
    <section>
      <h1 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>
        {t('pool.title')}
      </h1>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        {t('pool.subtitle')}
      </p>

      {error && <p className="alert error">{error}</p>}
      {ok && <p className="alert ok">{ok}</p>}

      <div
        className="filter-bar"
        style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem' }}
      >
        <input
          placeholder={t('pool.codePlaceholder')}
          maxLength={100}
          value={code}
          style={{ flex: 1, maxWidth: 320 }}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <button
          type="button"
          className="primary"
          disabled={busy || !code.trim()}
          onClick={() => void add()}
        >
          {t('pool.add')}
        </button>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('pool.colCode')}</th>
              <th>{t('pool.colType')}</th>
              <th>{t('pool.colConfig')}</th>
              <th>{t('pool.colBrand')}</th>
              <th>{t('pool.colAssignee')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  {t('pool.empty')}
                </td>
              </tr>
            ) : (
              items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <span className="mono">{it.code}</span>
                  </td>
                  <td>{it.type}</td>
                  <td>{it.configuration ?? '—'}</td>
                  <td>{it.brand ?? '—'}</td>
                  <td>{it.assignedUserName ?? '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="sm danger"
                      disabled={busy}
                      onClick={() => void remove(it)}
                    >
                      {t('pool.remove')}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

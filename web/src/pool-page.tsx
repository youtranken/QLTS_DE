import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import type { Me } from './panels';

interface AssetOption {
  id: string;
  code: string;
  type: string;
  status: string;
  isPool: boolean;
}

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

const typeIcon = (type: string | null): string => {
  const ty = (type ?? '').toLowerCase();
  if (ty.includes('laptop')) return '💻';
  if (ty.includes('desktop') || ty.includes('pc')) return '🖥️';
  if (ty.includes('printer') || ty.includes('máy in')) return '🖨️';
  if (ty.includes('monitor') || ty.includes('màn')) return '🖥️';
  if (ty.includes('phone') || ty.includes('điện thoại')) return '📱';
  return '📦';
};

/**
 * Pool máy cho mượn (8.4): admin thêm máy vào pool bằng MTS (mã tài sản) — thông tin kéo từ QLTS.
 * Đây là nguồn máy member thấy khi Đặt máy (availability lọc is_pool + in_use). Gỡ khỏi pool
 * dùng endpoint pool sẵn có (cascade hủy booking tương lai + báo mail).
 *
 * GET /api/admin/pool KHÔNG trả trạng thái rảnh/đang mượn (chỉ asset.status = in_use + chủ máy),
 * nên summary chỉ hiện tổng số máy và thẻ máy không gắn badge rảnh/bận.
 */
export function PoolPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PoolItem[]>([]);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<AssetOption[]>([]);
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

  // Gợi ý mã máy (9.6): chỉ thiết bị đang dùng, chưa nằm trong pool (server chặn lại lần cuối).
  useEffect(() => {
    if (!query.trim()) {
      setOptions([]);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/assets?search=${encodeURIComponent(query)}&page=1&pageSize=20`,
        { signal: c.signal },
      )
        .then(async (r) => {
          if (!r.ok) return;
          const body = (await r.json()) as { items?: AssetOption[] };
          setOptions(
            (body.items ?? []).filter(
              (a) => a.type !== 'software' && a.status === 'in_use' && !a.isPool,
            ),
          );
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const add = useCallback(
    async (codeArg: string) => {
      const c = codeArg.trim();
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
          setQuery('');
          setOptions([]);
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
    },
    [headers, load, t],
  );

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

      {/* API pool không trả rảnh/bận → chỉ hiện tổng số máy trong pool. */}
      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat-card" style={{ cursor: 'default' }}>
          <div className="stat-num">{items.length}</div>
          <div className="stat-label">{t('pool.statTotal', 'Máy trong pool')}</div>
        </div>
      </div>

      <div className="catalog-toolbar">
        <div style={{ flex: 1, minWidth: 240, maxWidth: 420 }}>
          <Combobox
            placeholder={t('pool.codePlaceholder')}
            query={query}
            onQuery={setQuery}
            options={options}
            disabled={busy}
            getKey={(a) => a.id}
            renderOption={(a) => (
              <>
                <span className="mono">{a.code}</span>
                <small>{a.type}</small>
              </>
            )}
            onSelect={(a) => void add(a.code)}
          />
        </div>
        <button
          type="button"
          className="primary"
          disabled={busy || !query.trim()}
          onClick={() => void add(query)}
        >
          {t('pool.add', 'Thêm vào pool')}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="muted">{t('pool.empty')}</p>
      ) : (
        <div className="mcatalog">
          {items.map((it) => (
            <div key={it.id} className="mcard">
              <div
                style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}
              >
                <div className="mc-ico">{typeIcon(it.type)}</div>
                <button
                  type="button"
                  className="sm danger"
                  disabled={busy}
                  onClick={() => void remove(it)}
                >
                  {t('pool.remove')}
                </button>
              </div>
              <div className="mc-code">{it.code}</div>
              <div className="mc-spec">
                {it.type}
                {it.configuration ? ` · ${it.configuration}` : ''}
                {it.brand ? ` · ${it.brand}` : ''}
              </div>
              {it.assignedUserName && (
                <div className="mc-spec mc-foot">
                  {t('pool.owner', 'Chủ máy')}: {it.assignedUserName}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

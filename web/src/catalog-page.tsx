import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

type Kind = 'type' | 'brand' | 'configuration';
const KINDS: Kind[] = ['type', 'brand', 'configuration'];

interface CatalogItem {
  id: string;
  value: string;
  active: boolean;
  usage: number;
}

/**
 * Quản trị → Danh mục (8.2): quản lý giá trị Loại/Hãng/Cấu hình cho form Thêm tài sản.
 * Thêm mới, ẩn/hiện (không đụng tài sản), và GỘP giá trị trùng (có xác nhận + số tài sản đổi).
 */
export function CatalogPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('type');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [newValue, setNewValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merge, setMerge] = useState<CatalogItem | null>(null);

  const headers = useMemo(
    () => ({
      'Content-Type': 'application/json',
      ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
    }),
    [me.csrfToken],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/catalog?kind=${kind}`);
      if (res.ok) setItems((await res.json()) as CatalogItem[]);
      else setError(t('catalog.loadFailed'));
    } catch {
      setError(t('catalog.loadFailed'));
    }
  }, [kind, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    const v = newValue.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/catalog', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind, value: v }),
      });
      if (res.ok || res.status === 201) {
        setNewValue('');
        await load();
      } else if (res.status === 409) {
        setError(t('catalog.taken'));
      } else {
        setError(t('catalog.saveFailed'));
      }
    } catch {
      setError(t('catalog.saveFailed'));
    } finally {
      setBusy(false);
    }
  }, [newValue, kind, headers, load, t]);

  const setActive = useCallback(
    async (item: CatalogItem, active: boolean) => {
      setBusy(true);
      try {
        await fetch(`/api/admin/catalog/${item.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ active }),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [headers, load],
  );

  return (
    <section>
      <h1 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>
        {t('catalog.title')}
      </h1>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        {t('catalog.subtitle')}
      </p>

      <div className="segmented" style={{ marginBottom: '1rem' }}>
        {KINDS.map((k) => (
          <label key={k}>
            <input
              type="radio"
              name="catalogKind"
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            {t(`catalog.kind.${k}`)}
          </label>
        ))}
      </div>

      {error && <p className="alert error">{error}</p>}

      <div
        className="filter-bar"
        style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem' }}
      >
        <input
          placeholder={t('catalog.newPlaceholder')}
          maxLength={2000}
          value={newValue}
          style={{ flex: 1, maxWidth: 360 }}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
        <button
          type="button"
          className="primary"
          disabled={busy || !newValue.trim()}
          onClick={() => void create()}
        >
          {t('catalog.add')}
        </button>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('catalog.colValue')}</th>
              <th>{t('catalog.colUsage')}</th>
              <th>{t('catalog.colActive')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  {t('catalog.empty')}
                </td>
              </tr>
            ) : (
              items.map((it) => (
                <tr key={it.id}>
                  <td>{it.value}</td>
                  <td>{it.usage}</td>
                  <td>
                    {it.active ? (
                      <span className="chip">{t('catalog.shown')}</span>
                    ) : (
                      <span className="muted">{t('catalog.hidden')}</span>
                    )}
                  </td>
                  <td style={{ display: 'flex', gap: '0.4rem' }}>
                    <button
                      type="button"
                      className="sm"
                      disabled={busy || items.length < 2}
                      onClick={() => setMerge(it)}
                    >
                      {t('catalog.merge')}
                    </button>
                    <button
                      type="button"
                      className="sm"
                      disabled={busy}
                      onClick={() => void setActive(it, !it.active)}
                    >
                      {it.active ? t('catalog.hide') : t('catalog.show')}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {merge && (
        <MergeDialog
          from={merge}
          candidates={items.filter((x) => x.id !== merge.id)}
          headers={headers}
          onClose={() => setMerge(null)}
          onDone={() => {
            setMerge(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** Popup gộp: chọn giá trị đích → xem trước số tài sản đổi → xác nhận. */
function MergeDialog({
  from,
  candidates,
  headers,
  onClose,
  onDone,
}: {
  from: CatalogItem;
  candidates: CatalogItem[];
  headers: Record<string, string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [toId, setToId] = useState('');
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!toId) {
      setPreview(null);
      return;
    }
    const c = new AbortController();
    fetch(`/api/admin/catalog/merge-preview?from=${from.id}&to=${toId}`, {
      signal: c.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ assetCount: number }>) : null))
      .then((d) => setPreview(d ? d.assetCount : null))
      .catch(() => undefined);
    return () => c.abort();
  }, [toId, from.id]);

  const confirm = useCallback(async () => {
    if (!toId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/catalog/merge', {
        method: 'POST',
        headers,
        body: JSON.stringify({ from: from.id, to: toId }),
      });
      if (res.ok || res.status === 201) onDone();
      else setError(t('catalog.mergeFailed'));
    } catch {
      setError(t('catalog.mergeFailed'));
    } finally {
      setBusy(false);
    }
  }, [toId, from.id, headers, onDone, t]);

  const toValue = candidates.find((c) => c.id === toId)?.value ?? '';

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: '0.75rem' }}>{t('catalog.mergeTitle')}</h2>
        <p style={{ marginBottom: '0.75rem' }}>
          {t('catalog.mergeFrom')}: <strong>{from.value}</strong>
        </p>
        <label className="field" style={{ marginBottom: '0.75rem' }}>
          <span>{t('catalog.mergeTo')}</span>
          <select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">—</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.value}
              </option>
            ))}
          </select>
        </label>
        {toId && preview !== null && (
          <p className="alert warn">
            {t('catalog.mergeWarn', {
              n: preview,
              from: from.value,
              to: toValue,
            })}
          </p>
        )}
        {error && <p className="alert error">{error}</p>}
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            marginTop: '1rem',
          }}
        >
          <button type="button" onClick={onClose}>
            {t('catalog.cancel')}
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy || !toId}
            onClick={() => void confirm()}
          >
            {t('catalog.mergeConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

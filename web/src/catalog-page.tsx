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

type ByKind<T> = Record<Kind, T>;
const emptyItems = (): ByKind<CatalogItem[]> => ({
  type: [],
  brand: [],
  configuration: [],
});
const emptyStrings = (): ByKind<string> => ({
  type: '',
  brand: '',
  configuration: '',
});

/**
 * Quản trị → Danh mục (8.2): quản lý giá trị Loại/Hãng/Cấu hình cho form Thêm tài sản.
 * 3 cột song song — mỗi kind một cột — thêm/sửa/gộp/ẩn tại chỗ (menu "⋯").
 */
export function CatalogPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ByKind<CatalogItem[]>>(emptyItems);
  const [newValues, setNewValues] = useState<ByKind<string>>(emptyStrings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merge, setMerge] = useState<{ kind: Kind; item: CatalogItem } | null>(
    null,
  );
  const [editing, setEditing] = useState<{
    kind: Kind;
    id: string;
    value: string;
  } | null>(null);
  const [menu, setMenu] = useState<{ kind: Kind; id: string } | null>(null);

  const headers = useMemo(
    () => ({
      'Content-Type': 'application/json',
      ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
    }),
    [me.csrfToken],
  );

  const loadKind = useCallback(async (k: Kind): Promise<boolean> => {
    const res = await fetch(`/api/admin/catalog?kind=${k}`);
    if (!res.ok) return false;
    const list = (await res.json()) as CatalogItem[];
    setItems((prev) => ({ ...prev, [k]: list }));
    return true;
  }, []);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const oks = await Promise.all(KINDS.map((k) => loadKind(k)));
      if (oks.some((ok) => !ok)) setError(t('catalog.loadFailed'));
    } catch {
      setError(t('catalog.loadFailed'));
    }
  }, [loadKind, t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const create = useCallback(
    async (k: Kind) => {
      const v = newValues[k].trim();
      if (!v) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/admin/catalog', {
          method: 'POST',
          headers,
          body: JSON.stringify({ kind: k, value: v }),
        });
        if (res.ok || res.status === 201) {
          setNewValues((prev) => ({ ...prev, [k]: '' }));
          await loadKind(k);
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
    },
    [newValues, headers, loadKind, t],
  );

  const rename = useCallback(async () => {
    if (!editing) return;
    const v = editing.value.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/catalog/${editing.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ value: v }),
      });
      if (res.ok) {
        const k = editing.kind;
        setEditing(null);
        await loadKind(k);
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
  }, [editing, headers, loadKind, t]);

  const setActive = useCallback(
    async (k: Kind, item: CatalogItem, active: boolean) => {
      setBusy(true);
      try {
        await fetch(`/api/admin/catalog/${item.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ active }),
        });
        await loadKind(k);
      } finally {
        setBusy(false);
      }
    },
    [headers, loadKind],
  );

  const countLabel = (n: number) =>
    n > 0 ? t('catalog.count', { n, defaultValue: '{{n}} máy' }) : '0';

  return (
    <section>
      <h1 style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>
        {t('catalog.title')}
      </h1>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        {t('catalog.subtitle')}
      </p>

      {error && (
        <p className="alert error" style={{ marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      <div className="dmboard">
        {KINDS.map((k) => (
          <div className="dmcol" key={k}>
            <div className="dm-h">
              <span>{t(`catalog.kind.${k}`)}</span>
              <span className="badge muted plain">{items[k].length}</span>
            </div>

            {items[k].length === 0 && (
              <div className="dmrow">
                <span className="dm-g muted">{t('catalog.empty')}</span>
              </div>
            )}

            {items[k].map((it) => {
              const isEditing = editing?.id === it.id;
              const isMenu = menu?.kind === k && menu.id === it.id;
              return (
                <div
                  className={`dmrow${it.usage === 0 ? ' is-empty' : ''}`}
                  key={it.id}
                >
                  {isEditing ? (
                    <input
                      className="dm-g"
                      autoFocus
                      maxLength={2000}
                      value={editing.value}
                      onChange={(e) =>
                        setEditing({
                          kind: k,
                          id: it.id,
                          value: e.target.value,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void rename();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    <span className="dm-g">
                      {it.value}
                      {!it.active && (
                        <span className="muted"> · {t('catalog.hidden')}</span>
                      )}
                    </span>
                  )}

                  {isEditing ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="sm primary"
                        disabled={busy || !editing.value.trim()}
                        onClick={() => void rename()}
                      >
                        {t('catalog.save')}
                      </button>
                      <button
                        type="button"
                        className="sm"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        {t('catalog.cancel')}
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="dm-ct">{countLabel(it.usage)}</span>
                      <div style={{ position: 'relative' }}>
                        <button
                          type="button"
                          className="sm"
                          aria-label={t('catalog.actions', {
                            defaultValue: 'Thao tác',
                          })}
                          disabled={busy}
                          onClick={() =>
                            setMenu(isMenu ? null : { kind: k, id: it.id })
                          }
                        >
                          ⋯
                        </button>
                        {isMenu && (
                          <>
                            <div
                              style={{ position: 'fixed', inset: 0, zIndex: 20 }}
                              onClick={() => setMenu(null)}
                            />
                            <div
                              style={{
                                position: 'absolute',
                                right: 0,
                                top: 'calc(100% + 4px)',
                                zIndex: 21,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 2,
                                minWidth: 120,
                                padding: 4,
                                background: 'var(--surface)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--r)',
                                boxShadow: '0 8px 24px rgba(0,0,0,.14)',
                              }}
                            >
                              <button
                                type="button"
                                className="sm ghost"
                                style={{ justifyContent: 'flex-start' }}
                                disabled={busy}
                                onClick={() => {
                                  setMenu(null);
                                  setEditing({
                                    kind: k,
                                    id: it.id,
                                    value: it.value,
                                  });
                                }}
                              >
                                {t('catalog.edit')}
                              </button>
                              <button
                                type="button"
                                className="sm ghost"
                                style={{ justifyContent: 'flex-start' }}
                                disabled={busy || items[k].length < 2}
                                onClick={() => {
                                  setMenu(null);
                                  setMerge({ kind: k, item: it });
                                }}
                              >
                                {t('catalog.merge')}
                              </button>
                              <button
                                type="button"
                                className="sm ghost"
                                style={{ justifyContent: 'flex-start' }}
                                disabled={busy}
                                onClick={() => {
                                  setMenu(null);
                                  void setActive(k, it, !it.active);
                                }}
                              >
                                {it.active
                                  ? t('catalog.hide')
                                  : t('catalog.show')}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            <div className="dm-add">
              <input
                style={{ flex: 1 }}
                maxLength={2000}
                placeholder={t('catalog.addPlaceholder', {
                  kind: t(`catalog.kind.${k}`).toLowerCase(),
                  defaultValue: '+ Thêm {{kind}}…',
                })}
                value={newValues[k]}
                onChange={(e) =>
                  setNewValues((prev) => ({ ...prev, [k]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create(k);
                }}
              />
              <button
                type="button"
                className="primary sm"
                disabled={busy || !newValues[k].trim()}
                onClick={() => void create(k)}
              >
                {t('catalog.add')}
              </button>
            </div>
          </div>
        ))}
      </div>

      {merge && (
        <MergeDialog
          from={merge.item}
          candidates={items[merge.kind].filter((x) => x.id !== merge.item.id)}
          headers={headers}
          onClose={() => setMerge(null)}
          onDone={() => {
            const k = merge.kind;
            setMerge(null);
            void loadKind(k);
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

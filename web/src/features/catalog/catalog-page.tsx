import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from '@/lib/me';

type Kind = 'type' | 'brand' | 'configuration' | 'place' | 'licenseName';
const KINDS: Kind[] = ['type', 'brand', 'configuration', 'place', 'licenseName'];

interface CatalogItem {
  id: string;
  value: string;
  active: boolean;
  deviceCount: number;
  softwareCount: number;
}

type ByKind<T> = Record<Kind, T>;
const emptyItems = (): ByKind<CatalogItem[]> => ({
  type: [],
  brand: [],
  configuration: [],
  place: [],
  licenseName: [],
});
const emptyStrings = (): ByKind<string> => ({
  type: '',
  brand: '',
  configuration: '',
  place: '',
  licenseName: '',
});

/**
 * Quản trị → Danh mục (8.2): quản lý giá trị Loại/Hãng/Cấu hình cho form Thêm tài sản.
 * Mỗi kind một tab — thêm/sửa/disable tại chỗ (menu "⋯"); đếm tách máy · phần mềm.
 */
export function CatalogPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ByKind<CatalogItem[]>>(emptyItems);
  const [newValues, setNewValues] = useState<ByKind<string>>(emptyStrings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    kind: Kind;
    id: string;
    value: string;
  } | null>(null);
  const [menu, setMenu] = useState<{ kind: Kind; id: string } | null>(null);
  // Redesign: chọn 1 danh mục qua tab (thay 3 cột dọc cố định) → dễ thêm trường về sau.
  const [activeKind, setActiveKind] = useState<Kind>('type');

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

  // Đếm tách: thiết bị (type≠software) và phần mềm (type=software) dùng cùng giá trị danh mục.
  const countLabel = (it: CatalogItem) => {
    const parts: string[] = [];
    if (it.deviceCount > 0)
      parts.push(t('catalog.countDevice', { n: it.deviceCount, defaultValue: '{{n}} máy' }));
    if (it.softwareCount > 0)
      parts.push(
        t('catalog.countSoftware', { n: it.softwareCount, defaultValue: '{{n}} phần mềm' }),
      );
    return parts.length ? parts.join(' · ') : '0';
  };

  return (
    <section className="catalog-page">
      <h1 style={{ fontSize: 'var(--fs-2xl)', marginBottom: '0.25rem' }}>
        {t('catalog.title')}
      </h1>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        {t('catalog.subtitle')}
      </p>

      {error && (
        <p role="alert" className="alert error" style={{ marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      {/* Master–detail: TRÁI = danh sách loại danh mục, PHẢI = mục của loại đang chọn. */}
      <div className="dm-split">
      <nav className="dm-kinds" role="tablist" aria-label={t('catalog.title')}>
        {KINDS.map((k) => (
          <label key={k} className={activeKind === k ? 'on' : ''}>
            <input
              type="radio"
              name="catalogKind"
              checked={activeKind === k}
              onChange={() => {
                // Đổi loại → bỏ trạng thái sửa inline / menu đang mở (tránh "ẩn mà còn sống").
                setActiveKind(k);
                setEditing(null);
                setMenu(null);
              }}
            />
            <span className="dm-kind-lbl">{t(`catalog.kind.${k}`)}</span>
            <span className="badge muted plain">{items[k].length}</span>
          </label>
        ))}
      </nav>

      <div className="dmboard">
        {[activeKind].map((k) => (
          <div className="dmcol" key={k}>
            <div className="dm-h">
              <span>{t(`catalog.kind.${k}`)}</span>
              <span className="badge muted plain">{items[k].length}</span>
            </div>

            {items[k].length === 0 ? (
              <div className="dm-empty muted">{t('catalog.empty')}</div>
            ) : (
            <div className="dm-list">
            {items[k].map((it) => {
              const isEditing = editing?.id === it.id;
              const isMenu = menu?.kind === k && menu.id === it.id;
              return (
                <div
                  className={`dmrow${it.deviceCount === 0 && it.softwareCount === 0 ? ' is-empty' : ''}${!it.active ? ' is-disabled' : ''}`}
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
                    <span className="dm-g">{it.value}</span>
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
                      <span className="dm-ct">{countLabel(it)}</span>
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
                                disabled={busy}
                                onClick={() => {
                                  setMenu(null);
                                  void setActive(k, it, !it.active);
                                }}
                              >
                                {it.active
                                  ? t('catalog.disable', { defaultValue: 'Disable' })
                                  : t('catalog.enable', { defaultValue: 'Enable' })}
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
            </div>
            )}

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
      </div>
    </section>
  );
}

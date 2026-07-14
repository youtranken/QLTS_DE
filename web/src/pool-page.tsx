import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import { PoolTable } from './pool-table';
import type { Me } from './panels';

interface AssetOption {
  id: string;
  code: string;
  type: string;
  status: string;
  isPool: boolean;
}

export interface PoolItem {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
  brand: string | null;
  status: string;
  version: number;
  assignedUserName: string | null;
  // B1 (UAT 2026-07-12): phần mềm đang cài trên máy (comma-joined).
  installedSoftware: string | null;
  // Người đang mượn (booking delivered / ticket in_use). null = máy sẵn sàng.
  currentBorrowerName: string | null;
}

/**
 * Pool máy cho mượn (8.4 + đại tu pool.html): admin thêm máy vào pool bằng MTS.
 * Trên cùng 3 thẻ (Tổng / Sẵn sàng / Đang mượn) — "đang mượn" từ read-model in-use-now (BE).
 * Bảng No/Code/User/Asset Type/Software (cột Software bung khi ≥2 phần mềm). Lọc client-side
 * (danh sách pool nhỏ, tải đầy đủ) theo search + Loại + Trạng thái, có chip lọc đang bật.
 */
export function PoolPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PoolItem[]>([]);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<AssetOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // Lọc bảng (client-side): tìm + Loại + Trạng thái (available/borrowing).
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

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

  const total = items.length;
  const borrowing = items.filter((it) => it.currentBorrowerName).length;
  const available = total - borrowing;
  const typeOptions = useMemo(
    () => [...new Set(items.map((it) => it.type))].sort(),
    [items],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (
        q &&
        !`${it.code} ${it.currentBorrowerName ?? ''} ${it.type} ${it.installedSoftware ?? ''}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      if (filterType && it.type !== filterType) return false;
      if (filterStatus === 'available' && it.currentBorrowerName) return false;
      if (filterStatus === 'borrowing' && !it.currentBorrowerName) return false;
      return true;
    });
  }, [items, search, filterType, filterStatus]);

  const hasFilter = search !== '' || filterType !== '' || filterStatus !== '';
  const clearFilters = () => {
    setSearch('');
    setFilterType('');
    setFilterStatus('');
  };

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

      {/* 3 thẻ trên 1 hàng: Tổng / Sẵn sàng / Đang mượn (theo pool.html). */}
      <div className="pool-stats">
        <div className="pool-stat">
          <div className="k">
            <span className="dot" />
            {t('pool.statTotal', 'Tổng trong pool')}
          </div>
          <div className="v">{total}</div>
        </div>
        <div className="pool-stat">
          <div className="k">
            <span className="dot ok" />
            {t('pool.statAvailable', 'Sẵn sàng')}
          </div>
          <div className="v">{available}</div>
        </div>
        <div className="pool-stat">
          <div className="k">
            <span className="dot warn" />
            {t('pool.statBorrowing', 'Đang mượn')}
          </div>
          <div className="v">{borrowing}</div>
        </div>
      </div>

      {/* Thêm máy vào pool bằng MTS (combobox gợi ý). */}
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
        <>
          {/* Lọc bảng: tìm + Loại + Trạng thái + chip đang bật. */}
          <div className="filter-bar">
            <input
              className="grow search"
              placeholder={t('pool.searchTable', 'Tìm mã, người mượn, phần mềm…')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label={t('pool.colAssetType', 'Asset Type')}
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
            >
              <option value="">{t('pool.filterType', 'Loại — tất cả')}</option>
              {typeOptions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <select
              aria-label={t('pool.filterStatusLabel', 'Trạng thái')}
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="">{t('pool.filterStatus', 'Trạng thái — tất cả')}</option>
              <option value="available">{t('pool.statAvailable', 'Sẵn sàng')}</option>
              <option value="borrowing">{t('pool.statBorrowing', 'Đang mượn')}</option>
            </select>
            {hasFilter && (
              <button type="button" onClick={clearFilters}>
                {t('assets.clearFilters')}
              </button>
            )}
          </div>
          {(filterType || filterStatus) && (
            <div className="active-filters">
              <span className="af-label">{t('assets.activeFilters', 'Đang lọc')}</span>
              {filterType && (
                <span className="chip filter-chip">
                  <b>{t('pool.colAssetType', 'Asset Type')}:</b>
                  {filterType}
                  <button type="button" aria-label={t('assets.clearFilters')} onClick={() => setFilterType('')}>
                    ✕
                  </button>
                </span>
              )}
              {filterStatus && (
                <span className="chip filter-chip">
                  <b>{t('pool.filterStatusLabel', 'Trạng thái')}:</b>
                  {filterStatus === 'available'
                    ? t('pool.statAvailable', 'Sẵn sàng')
                    : t('pool.statBorrowing', 'Đang mượn')}
                  <button type="button" aria-label={t('assets.clearFilters')} onClick={() => setFilterStatus('')}>
                    ✕
                  </button>
                </span>
              )}
            </div>
          )}
          {filtered.length === 0 ? (
            <p className="muted">{t('assets.noMatch')}</p>
          ) : (
            <PoolTable items={filtered} busy={busy} onRemove={(it) => void remove(it)} />
          )}
        </>
      )}
    </section>
  );
}

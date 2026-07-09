import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AssetForm } from './asset-form';
import {
  EMPTY_FORM,
  STATUS_BADGE,
  detailToForm,
} from './asset-types';
import type { AssetDetail, AssetRow, FormState } from './asset-types';
import type { Me } from './panels';

// Re-export để App.tsx tiếp tục import cả hai từ './assets' (route không đổi).
export { AssetDetailPage } from './asset-detail';

const PAGE_SIZE = 20;

/** Sổ tài sản (story 2.1) — danh sách phân trang + form thêm/sửa (popup). Admin/SA. */
export function AssetsPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // F7: khởi tạo lọc status từ URL (?status=locked_repair) — card dashboard "Máy đang khóa"
  // (3.12 AC1 ≤2 click) dẫn thẳng vào danh sách đã lọc, không rơi vào list không lọc.
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AssetRow[]>([]);
  const [total, setTotal] = useState(0);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tìm/lọc server-side (2.2): searchInput gõ tự do → search sau debounce 300ms
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState(() => {
    const s = searchParams.get('status') ?? '';
    return ['in_use', 'locked_repair', 'disposed'].includes(s) ? s : '';
  });
  // 7.7: badge dashboard dẫn tới ?expiring=true — lọc "sắp hết hạn"
  const [expiring, setExpiring] = useState(
    () => searchParams.get('expiring') === 'true',
  );
  const [meta, setMeta] = useState<{ types: string[] }>({
    types: [],
  });
  const hasFilter = search !== '' || type !== '' || status !== '' || expiring;

  useEffect(() => {
    const value = searchInput.trim();
    if (value === search) return; // gõ rồi xóa trong 300ms — không reset trang vô cớ
    const timer = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const loadMeta = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/assets/meta');
      if (!res.ok) return;
      const body = (await res.json()) as { types?: string[] };
      const types = body.types ?? [];
      setMeta({ types });
      // filter mồ côi (giá trị vừa biến mất khỏi sổ) → reset, tránh dropdown
      // trông như "tất cả" nhưng danh sách vẫn bị lọc (review 2.2)
      setType((v) => (v && !types.includes(v) ? '' : v));
    } catch {
      // dropdown thiếu lựa chọn không chặn màn hình — danh sách vẫn dùng được
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
        });
        if (search) params.set('search', search);
        if (type) params.set('type', type);
        if (status) params.set('status', status);
        if (expiring) params.set('expiring', 'true');
        const res = await fetch(`/api/admin/assets?${params.toString()}`, {
          signal,
        });
        if (res.status === 401) {
          window.location.href = '/';
          return;
        }
        const body = (await res.json()) as {
          items?: AssetRow[];
          total?: number;
          message?: string;
        };
        if (res.ok && Array.isArray(body.items)) {
          setItems(body.items);
          setTotal(body.total ?? 0);
        } else {
          setError(body.message ?? t('assets.loadFailed'));
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError(t('app.serverUnreachable'));
        }
      }
    },
    [page, search, type, status, expiring, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const openEdit = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
        if (!res.ok) {
          setError(t('assets.loadFailed'));
          return;
        }
        const a = (await res.json()) as AssetDetail;
        setForm(detailToForm(a));
      } catch {
        setError(t('app.serverUnreachable'));
      }
    },
    [t],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-header">
        <h1>{t('nav.assets')}</h1>
        <Link className="linkbtn" to="/tai-san/kiem-ke">
          {t('inventory.link')}
        </Link>
        <Link className="linkbtn" to="/tai-san/import">
          {t('importx.link')}
        </Link>
        {/* 2.10: export theo bộ lọc ĐANG áp — <a> điều hướng thật, cookie đi kèm */}
        <a
          className="linkbtn"
          href={`/api/admin/assets/export?${new URLSearchParams({
            ...(search ? { search } : {}),
            ...(type ? { type } : {}),
            ...(status ? { status } : {}),
            ...(expiring ? { expiring: 'true' } : {}),
          }).toString()}`}
        >
          {t('assets.exportExcel')}
        </a>
        <button
          type="button"
          className="primary"
          onClick={() => setForm(EMPTY_FORM)}
        >
          {t('assets.addAsset')}
        </button>
      </div>
      {error && <p className="alert error">{error}</p>}
      <div className="filter-bar">
        <input
          className="grow search"
          placeholder={t('assets.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('assets.filterType')}</option>
          {meta.types.map((v) => (
            <option key={v} value={v}>
              {v === 'software' ? t('assets.kindSoftware') : v}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('assets.filterStatus')}</option>
          {['in_use', 'locked_repair', 'disposed'].map((v) => (
            <option key={v} value={v}>
              {t(`assets.status.${v}`)}
            </option>
          ))}
        </select>
        {expiring && (
          <span className="chip">
            {t('assets.expiringFilter')}
            <button
              type="button"
              aria-label={t('assets.clearFilters')}
              onClick={() => {
                setExpiring(false);
                setPage(1);
              }}
            >
              ✕
            </button>
          </span>
        )}
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setSearchInput('');
              setSearch('');
              setType('');
              setStatus('');
              setExpiring(false);
              setPage(1);
            }}
          >
            {t('assets.clearFilters')}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('assets.code')}</th>
              <th>{t('assets.type')}</th>
              <th>{t('assets.assignee')}</th>
              <th>{t('assets.statusLabel')}</th>
              <th>{t('assets.pool')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              // click dòng → xem chi tiết (AC 1; trang 3 tab là 2.7)
              <tr
                key={a.id}
                // FR-38: license sắp hết hạn → viền trái đỏ (class overdue)
                className={a.licenseWarning ? 'overdue' : undefined}
                onClick={() => {
                  // đang bôi đen copy mã → không phải ý định mở trang (review 2.2)
                  if (window.getSelection()?.toString()) return;
                  navigate(`/tai-san/${a.id}`);
                }}
                title={
                  a.licenseWarning ? t('assets.licenseWarningHint') : undefined
                }
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <span className="mono">{a.code}</span>
                </td>
                <td>{a.type === 'software' ? t('assets.kindSoftware') : a.type}</td>
                <td>{a.assignedUserName ?? a.assignedUserSub ?? '—'}</td>
                <td>
                  <span className={`badge ${STATUS_BADGE[a.status] ?? 'muted'}`}>
                    {t(`assets.status.${a.status}`)}
                  </span>
                </td>
                <td>
                  {a.isPool ? (
                    <span className="badge ok plain">{t('assets.pool')}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="table-actions">
                  <button
                    type="button"
                    className="sm"
                    onClick={(e) => {
                      e.stopPropagation(); // tr đã có onClick — không mở 2 lần
                      void openEdit(a.id);
                    }}
                  >
                    {t('assets.edit')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length === 0 && (
        <p className="empty">
          {hasFilter ? t('assets.noMatch') : t('assets.empty')}
        </p>
      )}
      <div
        style={{
          marginTop: '0.75rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          ‹ {t('assets.prev')}
        </button>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {t('assets.pageOf', { page, totalPages, total })}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          {t('assets.next')} ›
        </button>
      </div>

      {form && (
        <AssetForm
          me={me}
          initial={form}
          onDone={(saved) => {
            setForm(null);
            if (saved) {
              void load();
              void loadMeta();
            }
          }}
        />
      )}
    </>
  );
}

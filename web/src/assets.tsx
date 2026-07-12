import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef, OnChangeFn, SortingState } from '@tanstack/react-table';
import { AssetForm } from './asset-form';
import { apiFetch } from './api-client';
import { DataTable } from './ui/data-table';
import {
  EMPTY_FORM,
  STATUS_BADGE,
  detailToForm,
} from './asset-types';
import type {
  AllocationRow,
  AssetDetail,
  AssetRow,
  NoteRow,
  FormState,
} from './asset-types';
import type { Me } from './panels';

// Re-export để App.tsx tiếp tục import cả hai từ './assets' (route không đổi).
export { AssetDetailPage } from './asset-detail';

const PAGE_SIZE = 20;

/**
 * Sổ tài sản (story 2.1) — danh sách phân trang + form thêm/sửa (popup). Admin/SA.
 * softwareOnly (9.1): tab "Phần mềm" — lọc cứng type=software, thêm/copy phần mềm.
 */
export function AssetsPage({
  me,
  softwareOnly = false,
}: {
  me: Me;
  softwareOnly?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // F7: khởi tạo lọc status từ URL (?status=locked_repair) — card dashboard "Máy đang khóa"
  // (3.12 AC1 ≤2 click) dẫn thẳng vào danh sách đã lọc, không rơi vào list không lọc.
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
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
  // Sắp xếp server-side (P1): DataTable controlled → map sang ?sort=&dir= → refetch.
  const [sorting, setSorting] = useState<SortingState>([]);
  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    setSorting((prev) =>
      typeof updater === 'function' ? updater(prev) : updater,
    );
    setPage(1);
  };
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

  // Danh sách qua TanStack Query: cache/dedup/hủy tự động; 401 xử lý tập trung ở apiFetch.
  const { data: listData, isError: listError } = useQuery({
    queryKey: [
      'assets',
      {
        page,
        search,
        type,
        status,
        expiring,
        softwareOnly,
        sort: sorting[0]?.id ?? null,
        dir: sorting[0]?.desc ? 'desc' : 'asc',
      },
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (search) params.set('search', search);
      // Tab Phần mềm: khóa cứng type=software (bỏ qua dropdown loại).
      if (softwareOnly) params.set('type', 'software');
      else if (type) params.set('type', type);
      if (status) params.set('status', status);
      if (expiring) params.set('expiring', 'true');
      if (sorting.length > 0) {
        params.set('sort', sorting[0].id);
        params.set('dir', sorting[0].desc ? 'desc' : 'asc');
      }
      return apiFetch<{ items: AssetRow[]; total: number }>(
        `/api/admin/assets?${params.toString()}`,
      );
    },
    // giữ trang cũ khi đổi trang/sort → không nháy trắng giữa các lần fetch
    placeholderData: (prev) => prev,
  });
  const items = listData?.items ?? [];
  const total = listData?.total ?? 0;

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

  // 9.1: Copy phần mềm — nhân bản 1 bản ghi gần giống sang form TẠO MỚI (mã trống, chưa gắn máy).
  const copyFrom = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
        if (!res.ok) {
          setError(t('assets.loadFailed'));
          return;
        }
        const a = (await res.json()) as AssetDetail;
        setForm({
          ...detailToForm(a),
          id: null,
          version: 1,
          status: 'in_use',
          code: '',
          installedOnAssetId: '',
          installedOnCode: '',
        });
      } catch {
        setError(t('app.serverUnreachable'));
      }
    },
    [t],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // id cột KHỚP whitelist BE (code/type/status/assignee) → map thẳng sang ?sort=.
  // Tab Phần mềm (softwareOnly) và Sổ tài sản dùng bộ cột KHÁC nhau (sw-license-model-redesign):
  // phần mềm định danh bằng Tên license + Máy + Kỳ hạn; máy có cột "Phần mềm" gọn.
  const columns = useMemo<ColumnDef<AssetRow, unknown>[]>(() => {
    const statusCol: ColumnDef<AssetRow, unknown> = {
      id: 'status',
      accessorKey: 'status',
      header: t('assets.statusLabel'),
      cell: ({ row }) => (
        <span className={`badge ${STATUS_BADGE[row.original.status] ?? 'muted'}`}>
          {t(`assets.status.${row.original.status}`)}
        </span>
      ),
    };
    const actionsCol: ColumnDef<AssetRow, unknown> = {
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="table-actions">
          <button
            type="button"
            className="sm"
            onClick={(e) => {
              e.stopPropagation(); // dòng có onRowClick — không mở 2 lần
              void openEdit(row.original.id);
            }}
          >
            {t('assets.edit')}
          </button>
          {softwareOnly && (
            <button
              type="button"
              className="sm"
              onClick={(e) => {
                e.stopPropagation();
                void copyFrom(row.original.id);
              }}
            >
              {t('software.copy')}
            </button>
          )}
        </div>
      ),
    };
    if (softwareOnly) {
      return [
        {
          id: 'license',
          accessorKey: 'licenseName',
          header: t('assets.licenseName'),
          enableSorting: false, // định danh mới; sort theo tên license chưa whitelist BE
          cell: ({ row }) => row.original.licenseName ?? '—',
        },
        {
          id: 'host',
          header: t('assets.hostCol'),
          enableSorting: false,
          cell: ({ row }) =>
            row.original.installedOnCode ? (
              <span className="mono">{row.original.installedOnCode}</span>
            ) : (
              <span className="muted">{t('assets.installedNone')}</span>
            ),
        },
        {
          id: 'assignee', // BE sort 'assignee' đã derive holder từ máy cho phần mềm
          accessorKey: 'assignedUserName',
          header: t('assets.assignee'),
          cell: ({ row }) => {
            const r = row.original;
            const holder = r.assignedUserName ?? r.assignedUserSub;
            if (holder) return holder;
            // Phân biệt: chưa gắn máy (—) vs gắn máy nhưng máy chưa có người đứng tên.
            return r.installedOnCode ? (
              <span className="muted">{t('assets.hostNoHolder')}</span>
            ) : (
              '—'
            );
          },
        },
        {
          id: 'term',
          header: t('assets.termCol'),
          enableSorting: false,
          cell: ({ row }) =>
            row.original.licenseType === 'perpetual'
              ? t('assets.licensePerpetual')
              : (row.original.endDate ?? '—'),
        },
        statusCol,
        actionsCol,
      ];
    }
    return [
      {
        id: 'code',
        accessorKey: 'code',
        header: t('assets.code'),
        // Sổ tài sản có thể lẫn dòng phần mềm (không mã) → hiện Tên license thay mã.
        cell: ({ row }) =>
          row.original.code ? (
            <span className="mono">{row.original.code}</span>
          ) : (
            (row.original.licenseName ?? '—')
          ),
      },
      {
        id: 'type',
        accessorKey: 'type',
        header: t('assets.type'),
        cell: ({ row }) =>
          row.original.type === 'software'
            ? t('assets.kindSoftware')
            : row.original.type,
      },
      {
        id: 'software',
        header: t('assets.swCol'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.installedSoftware ? (
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              {row.original.installedSoftware}
            </span>
          ) : (
            <span className="muted">—</span>
          ),
      },
      {
        id: 'assignee',
        accessorKey: 'assignedUserName',
        header: t('assets.assignee'),
        cell: ({ row }) =>
          row.original.assignedUserName ?? row.original.assignedUserSub ?? '—',
      },
      statusCol,
      {
        id: 'pool',
        header: t('assets.pool'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.isPool ? (
            <span className="badge ok plain">{t('assets.pool')}</span>
          ) : (
            <span className="muted">—</span>
          ),
      },
      actionsCol,
    ];
  }, [t, softwareOnly, openEdit, copyFrom]);

  return (
    <>
      <div className="page-header">
        <h1>{softwareOnly ? t('software.title') : t('nav.assets')}</h1>
        {!softwareOnly && (
          <>
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
          </>
        )}
        {/* sw-license-model follow-up: export PHẦN MỀM riêng (derive người đứng tên theo máy) */}
        {softwareOnly && (
          <a
            className="linkbtn"
            href={`/api/admin/assets/export-software?${new URLSearchParams({
              ...(search ? { search } : {}),
              ...(status ? { status } : {}),
              ...(expiring ? { expiring: 'true' } : {}),
            }).toString()}`}
          >
            {t('assets.exportExcel')}
          </a>
        )}
        <button
          type="button"
          className="primary"
          onClick={() =>
            setForm(
              softwareOnly ? { ...EMPTY_FORM, isSoftware: true } : EMPTY_FORM,
            )
          }
        >
          {softwareOnly ? t('software.add') : t('assets.addAsset')}
        </button>
      </div>
      {(error || listError) && (
        <p className="alert error">{error ?? t('assets.loadFailed')}</p>
      )}
      <div className="filter-bar">
        <input
          className="grow search"
          placeholder={t('assets.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {!softwareOnly && (
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
        )}
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
      <DataTable
        data={items}
        columns={columns}
        emptyText={hasFilter ? t('assets.noMatch') : t('assets.empty')}
        manualSorting
        sorting={sorting}
        onSortingChange={onSortingChange}
        rowClassName={(a) => (a.licenseWarning ? 'overdue' : '')}
        onRowClick={(a) => {
          // đang bôi đen copy mã → không phải ý định mở trang (review 2.2)
          if (window.getSelection()?.toString()) return;
          navigate(`/tai-san/${a.id}`);
        }}
        renderExpanded={(a) => <AssetExpanded asset={a} />}
      />
      {items.length > 0 && (
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
      )}

      {form && (
        <AssetForm
          me={me}
          initial={form}
          onDone={(saved) => {
            setForm(null);
            if (saved) {
              void queryClient.invalidateQueries({ queryKey: ['assets'] });
              void loadMeta();
            }
          }}
        />
      )}
    </>
  );
}

/**
 * Panel bung in-context ở Danh sách tài sản (▸ của DataTable) — xem nhanh lịch sử cấp
 * phát / phần mềm / ghi chú mà KHÔNG rời trang. Chỉ fetch khi hàng được mở (mount).
 */
function AssetExpanded({ asset }: { asset: AssetRow }) {
  const { t } = useTranslation();
  const isMachine = asset.type !== 'software';
  const [loading, setLoading] = useState(true);
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [software, setSoftware] = useState<
    Array<{ id: string; code: string; licenseName: string | null }>
  >([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const id = encodeURIComponent(asset.id);
    void Promise.all([
      apiFetch<AllocationRow[]>(`/api/admin/assets/${id}/allocations`).catch(
        () => [] as AllocationRow[],
      ),
      apiFetch<NoteRow[]>(`/api/admin/assets/${id}/notes`).catch(
        () => [] as NoteRow[],
      ),
      isMachine
        ? apiFetch<Array<{ id: string; code: string; licenseName: string | null }>>(
            `/api/admin/assets/${id}/software`,
          ).catch(() => [])
        : Promise.resolve(
            [] as Array<{ id: string; code: string; licenseName: string | null }>,
          ),
    ]).then(([al, nt, sw]) => {
      if (!alive) return;
      setAllocations(al);
      setNotes(nt);
      setSoftware(sw);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [asset.id, isMachine]);

  if (loading) {
    return (
      <div className="panel">
        <span className="muted-empty">…</span>
      </div>
    );
  }

  return (
    <div className="panel">
      <div>
        <h5>{t('assets.expAlloc', 'Lịch sử cấp phát')}</h5>
        {allocations.length === 0 ? (
          <div className="muted-empty">—</div>
        ) : (
          allocations.slice(0, 3).map((a) => (
            <div className="row" key={a.id}>
              {a.toUserName ?? a.toUserSub ?? t('assets.expStore', 'Kho')}
              {a.fromUserName ? ` ← ${a.fromUserName}` : ''}
            </div>
          ))
        )}
      </div>
      {isMachine && (
        <div>
          <h5>{t('assets.installedSoftware', 'Phần mềm cài sẵn')}</h5>
          {software.length === 0 ? (
            <div className="muted-empty">
              {t('assets.expNoSw', 'Chưa gắn phần mềm.')}
            </div>
          ) : (
            software.map((s) => (
              <div className="row" key={s.id}>
                {s.licenseName ?? (
                  <span className="mono">{s.code}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
      <div>
        <h5>{t('assets.expNotes', 'Ghi chú gần đây')}</h5>
        {notes.length === 0 ? (
          <div className="muted-empty">—</div>
        ) : (
          notes.slice(0, 3).map((n) => (
            <div className="row" key={n.id}>
              {n.note ?? ''}
            </div>
          ))
        )}
        <div style={{ marginTop: 6 }}>
          <Link to={`/tai-san/${asset.id}`}>
            {t('assets.expDetail', 'Xem chi tiết →')}
          </Link>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef, OnChangeFn, SortingState } from '@tanstack/react-table';
import { AssetForm } from './asset-form';
import { apiFetch } from './api-client';
import { AssetSoftwareExpand } from './asset-software-list';
import { SoftwareTransferDialog } from './software-transfer-dialog';
import { RowActionsMenu } from './asset-row-actions';
import type { RowAction } from './asset-row-actions';
import { useAssetLifecycle } from './asset-lifecycle-actions';
import { DataTable } from './ui/data-table';
import {
  EMPTY_FORM,
  STATUS_BADGE,
  detailToForm,
  formatVnd,
} from './asset-types';
import type {
  AssetDetail,
  AssetRow,
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
  disposedOnly = false,
  licenseName,
}: {
  me: Me;
  softwareOnly?: boolean;
  // B4 (UAT 2026-07-12): "Kho thanh lý" — chỉ tài sản đã thanh lý (đọc) + Tái sử dụng.
  disposedOnly?: boolean;
  // Chi tiết nhóm license: chỉ liệt kê các bản (seat) của tên license này (softwareOnly).
  licenseName?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // F7: khởi tạo lọc status từ URL (?status=locked_repair) — card dashboard "Máy đang khóa"
  // (3.12 AC1 ≤2 click) dẫn thẳng vào danh sách đã lọc, không rơi vào list không lọc.
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<FormState | null>(null);
  // Gắn/chuyển 1 bản (seat) phần mềm sang máy — mở dialog từ kebab (trang chi tiết license).
  const [transferSw, setTransferSw] = useState<AssetRow | null>(null);
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
  // Seat được chọn từ bảng con /phan-mem → bôi sáng dòng tương ứng.
  const seatParam = searchParams.get('seat');
  // Lọc theo dõi hạn tự chọn: khoảng end_date [endFrom, endTo] (cả /tai-san lẫn /phan-mem).
  const [endFrom, setEndFrom] = useState('');
  const [endTo, setEndTo] = useState('');
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
  const hasFilter =
    search !== '' ||
    type !== '' ||
    status !== '' ||
    expiring ||
    endFrom !== '' ||
    endTo !== '';

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
        endFrom,
        endTo,
        softwareOnly,
        disposedOnly,
        licenseName: licenseName ?? null,
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
      // Tab Phần mềm: khóa cứng type=software. Ngược lại (sổ tài sản) LOẠI phần mềm ra —
      // phần mềm có danh sách riêng ở /phan-mem (phân biệt rõ 2 danh sách).
      if (softwareOnly) params.set('type', 'software');
      // Chi tiết nhóm license: chỉ các bản (seat) của tên license này.
      if (licenseName) params.set('licenseName', licenseName);
      if (softwareOnly) {
        /* type đã set ở trên */
      } else {
        // "Sắp hết hạn" (expiring) đếm CẢ license → view này KHÔNG loại phần mềm, để
        // count badge khớp danh sách (H1). Ngoài ra sổ tài sản chỉ máy.
        if (!expiring) params.set('excludeSoftware', 'true');
        if (type) params.set('type', type);
      }
      if (endFrom) params.set('endFrom', endFrom);
      if (endTo) params.set('endTo', endTo);
      // Kho thanh lý: khóa cứng status=disposed (bỏ qua dropdown trạng thái).
      if (disposedOnly) params.set('status', 'disposed');
      else if (status) params.set('status', status);
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

  // 11.1: Xóa cứng tài sản "sạch". BE chặn (409) nếu đã ở pool/có booking/software/lịch sử
  // → hiện đúng message hướng dùng Thanh lý. Gửi version (optimistic lock) + CSRF.
  const handleDelete = useCallback(
    async (row: AssetRow) => {
      setError(null);
      const label = row.code ?? row.licenseName ?? '';
      if (!window.confirm(t('assets.deleteConfirm', { code: label }))) return;
      try {
        // List không trả version → lấy version tươi từ detail (optimistic lock).
        const detailRes = await fetch(
          `/api/admin/assets/${encodeURIComponent(row.id)}`,
        );
        if (!detailRes.ok) {
          setError(t('assets.deleteFailed'));
          return;
        }
        const { version } = (await detailRes.json()) as AssetDetail;
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(row.id)}`,
          {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({ version }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          setError(body?.message ?? t('assets.deleteFailed'));
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ['assets'] });
        void loadMeta();
      } catch {
        setError(t('app.serverUnreachable'));
      }
    },
    [t, me.csrfToken, queryClient, loadMeta],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Vòng đời máy (Khóa sửa chữa/Mở khóa/Pool) TỪ kebab — thay khối Vòng đời trong form.
  const lifecycle = useAssetLifecycle({
    me,
    onChanged: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      void loadMeta();
    },
  });

  // id cột KHỚP whitelist BE (code/type/status/assignee) → map thẳng sang ?sort=.
  // Tab Phần mềm (softwareOnly) và Sổ tài sản dùng bộ cột KHÁC nhau (sw-license-model-redesign):
  // phần mềm định danh bằng Tên license + Máy + Kỳ hạn; máy có cột "Phần mềm" gọn.
  const columns = useMemo<ColumnDef<AssetRow, unknown>[]>(() => {
    // No = STT liên tục theo trang (page-size 20) — chỉ hiển thị, không sort.
    const noCol: ColumnDef<AssetRow, unknown> = {
      id: 'no',
      header: t('assets.col.no', 'No'),
      enableSorting: false,
      cell: ({ row, table }) =>
        (page - 1) * PAGE_SIZE +
        table.getRowModel().rows.findIndex((r) => r.id === row.id) +
        1,
    };
    const statusCol: ColumnDef<AssetRow, unknown> = {
      id: 'status',
      accessorKey: 'status',
      header: t('assets.col.status'),
      cell: ({ row }) => (
        <span className={`badge ${STATUS_BADGE[row.original.status] ?? 'muted'}`}>
          {t(`assets.status.${row.original.status}`)}
        </span>
      ),
    };
    // Action gom vào menu "⋯" (3-chấm) cho gọn. Kho thanh lý: hồ sơ đã chốt — chỉ "Tái sử dụng".
    const actionsCol: ColumnDef<AssetRow, unknown> = {
      id: 'actions',
      header: t('assets.col.action'),
      enableSorting: false,
      cell: ({ row }) => {
        const a = row.original;
        // Dòng đã thanh lý (kể cả khi lọc status=disposed ở sổ tài sản): hồ sơ đã chốt →
        // chỉ "Tái sử dụng", KHÔNG Sửa/Xóa (BE chặn, tránh action ra lỗi khó hiểu).
        const actions: RowAction[] = (disposedOnly || a.status === 'disposed')
          ? [{ label: t('assets.reuse', 'Tái sử dụng'), onClick: () => void copyFrom(a.id) }]
          : [
              { label: t('assets.edit'), onClick: () => void openEdit(a.id) },
              ...(softwareOnly
                ? [
                    {
                      label: t('software.assignMachine'),
                      onClick: () => setTransferSw(a),
                    },
                    { label: t('software.copy'), onClick: () => void copyFrom(a.id) },
                  ]
                : []),
              // Khóa sửa chữa / Mở khóa / Pool (chỉ máy; software → []).
              ...lifecycle.actionsFor(a),
              {
                label: t('assets.delete'),
                danger: true,
                onClick: () => void handleDelete(a),
              },
            ];
        return <RowActionsMenu actions={actions} />;
      },
    };
    if (softwareOnly) {
      return [
        noCol,
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
    // Bảng Tài sản (đại tu UAT): cột thông số theo tên English cố định. Thông số mới
    // (Configuration/Cost/Start Date/Place/Pool) không sort — BE chỉ whitelist code/type/status/assignee.
    return [
      noCol,
      {
        id: 'code',
        accessorKey: 'code',
        header: t('assets.col.code'),
        // Sổ tài sản có thể lẫn dòng phần mềm (không mã) → hiện Tên license thay mã.
        cell: ({ row }) =>
          row.original.code ? (
            <span className="mono">{row.original.code}</span>
          ) : (
            (row.original.licenseName ?? '—')
          ),
      },
      {
        id: 'assignee',
        accessorKey: 'assignedUserName',
        header: t('assets.col.user'),
        cell: ({ row }) =>
          row.original.assignedUserName ?? row.original.assignedUserSub ?? '—',
      },
      {
        id: 'type',
        accessorKey: 'type',
        header: t('assets.col.type'),
        cell: ({ row }) =>
          row.original.type === 'software'
            ? t('assets.kindSoftware')
            : row.original.type,
      },
      {
        id: 'configuration',
        header: t('assets.col.configuration'),
        enableSorting: false,
        cell: ({ row }) => row.original.configuration ?? '—',
      },
      {
        id: 'cost',
        header: t('assets.col.cost'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.cost == null ? (
            '—'
          ) : (
            <span className="mono">{formatVnd(row.original.cost)}</span>
          ),
      },
      {
        id: 'startDate',
        header: t('assets.col.startDate'),
        enableSorting: false,
        cell: ({ row }) => row.original.startDate ?? '—',
      },
      {
        id: 'place',
        header: t('assets.col.place'),
        enableSorting: false,
        cell: ({ row }) => row.original.floor ?? '—',
      },
      statusCol,
      {
        id: 'pool',
        header: t('assets.col.pool'),
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
  }, [
    t,
    page,
    softwareOnly,
    disposedOnly,
    openEdit,
    copyFrom,
    handleDelete,
    lifecycle.actionsFor,
  ]);

  return (
    <>
      {licenseName && (
        <p style={{ marginBottom: '0.5rem' }}>
          <Link to="/phan-mem">‹ {t('software.backToGroups')}</Link>
        </p>
      )}
      <div className="page-header">
        <h1>
          {licenseName
            ? licenseName
            : disposedOnly
              ? t('disposed.title', 'Kho thanh lý')
              : softwareOnly
                ? t('software.title')
                : t('nav.assets')}
        </h1>
        {!softwareOnly && !disposedOnly && (
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
                ...(endFrom ? { endFrom } : {}),
                ...(endTo ? { endTo } : {}),
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
              ...(endFrom ? { endFrom } : {}),
              ...(endTo ? { endTo } : {}),
            }).toString()}`}
          >
            {t('assets.exportExcel')}
          </a>
        )}
        {!disposedOnly && (
          <button
            type="button"
            className="primary"
            onClick={() =>
              setForm(
                softwareOnly
                  ? { ...EMPTY_FORM, isSoftware: true, licenseName: licenseName ?? '' }
                  : EMPTY_FORM,
              )
            }
          >
            {softwareOnly
              ? licenseName
                ? t('software.addSeat')
                : t('software.add')
              : t('assets.addAsset')}
          </button>
        )}
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
            {/* Sổ tài sản không hiện phần mềm → bỏ 'software' khỏi bộ lọc Loại. */}
            {meta.types
              .filter((v) => v !== 'software')
              .map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
          </select>
        )}
        {!disposedOnly && (
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
        )}
        {/* Theo dõi hạn: lọc end_date theo khoảng ngày tự chọn (cả sổ tài sản & phần mềm). */}
        <label className="field-inline">
          <span className="muted">{t('assets.endFrom', 'Hết hạn từ')}</span>
          <input
            type="date"
            value={endFrom}
            max={endTo || undefined}
            onChange={(e) => {
              setEndFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="field-inline">
          <span className="muted">{t('assets.endTo', 'đến')}</span>
          <input
            type="date"
            value={endTo}
            min={endFrom || undefined}
            onChange={(e) => {
              setEndTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
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
              setEndFrom('');
              setEndTo('');
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
        rowClassName={(a) =>
          a.id === seatParam ? 'row-highlight' : a.licenseWarning ? 'overdue' : ''
        }
        onRowClick={(a) => {
          // đang bôi đen copy mã → không phải ý định mở trang (review 2.2)
          if (window.getSelection()?.toString()) return;
          navigate(`/tai-san/${a.id}`);
        }}
        // ▸ chỉ hiện khi máy CÓ phần mềm đã gắn; bung ra là bảng phần mềm của máy đó.
        canExpand={(a) => !!a.installedSoftware}
        renderExpanded={(a) => <AssetSoftwareExpand assetId={a.id} />}
        stackOnMobile
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
          lockSoftware={softwareOnly}
          onDone={(saved) => {
            setForm(null);
            if (saved) {
              void queryClient.invalidateQueries({ queryKey: ['assets'] });
              void loadMeta();
            }
          }}
        />
      )}

      {/* Popup Khóa sửa chữa + xác nhận cascade (từ kebab) + toast lỗi. */}
      {lifecycle.overlay}

      {/* Gắn/chuyển 1 bản phần mềm sang máy (từ kebab trang chi tiết license). */}
      {transferSw && (
        <SoftwareTransferDialog
          me={me}
          softwareId={transferSw.id}
          currentHostCode={transferSw.installedOnCode}
          onDone={(changed) => {
            setTransferSw(null);
            if (changed) {
              void queryClient.invalidateQueries({ queryKey: ['assets'] });
            }
          }}
        />
      )}
    </>
  );
}

/** Trang chi tiết 1 nhóm license (/phan-mem/license/:name) — liệt kê từng bản (seat). */
export function SoftwareLicensePage({ me }: { me: Me }) {
  const { name } = useParams<{ name: string }>();
  return <AssetsPage me={me} softwareOnly licenseName={name ?? ''} />;
}

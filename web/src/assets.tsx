import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnChangeFn, SortingState } from '@tanstack/react-table';
import { AssetForm } from '@/asset-form';
import { apiFetch } from '@/lib/api-client';
import { AssetSoftwareExpand } from '@/asset-software-list';
import { SoftwareTransferDialog } from '@/software-transfer-dialog';
import { OwnerTransferDialog } from '@/owner-transfer-dialog';
import { useAssetLifecycle } from '@/asset-lifecycle-actions';
import { DataTable } from '@/ui/data-table';
import { EMPTY_FORM, detailToForm } from '@/asset-types';
import type { AssetDetail, AssetRow, FormState } from '@/asset-types';
import type { Me } from '@/lib/me';
import { useAssetPageActions } from '@/use-asset-page-actions';
import { useAssetColumns } from '@/assets-columns';
import { AssetsFilterBar } from '@/assets-filter-bar';
import { AssetsPageHeader } from '@/assets-page-header';
import { useQuickImport, QuickImportSlot } from '@/import-page';
import { ReactivateDialog } from '@/reactivate-dialog';
import { ConfirmDialog } from '@/ui/confirm-dialog';

// Re-export để App.tsx tiếp tục import cả hai từ './assets' (route không đổi).
export { AssetDetailPage } from '@/asset-detail';

const PAGE_SIZE = 20;

/**
 * Sổ tài sản (story 2.1) — danh sách phân trang + form thêm/sửa (popup). Admin/SA.
 * softwareOnly (9.1): tab "Phần mềm" — lọc cứng type=software, thêm/copy phần mềm.
 * Cột / thao tác hàng / thanh lọc / đầu trang tách ra file riêng (§6); file này giữ
 * state + query danh sách + bảng + phân trang + các popup.
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
  // Chuyển máy sang người khác (đổi người đứng tên) — mở dialog từ nút "Chuyển" ở cột Action.
  const [transferOwner, setTransferOwner] = useState<AssetRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Import "1 chạm" (VĐ3): bấm → hộp chọn file → sạch thì nạp ngay, lỗi thì báo cụ thể.
  const quickImport = useQuickImport({
    me,
    kind: 'assets',
    onCommitted: () => queryClient.invalidateQueries({ queryKey: ['assets'] }),
  });
  // Tái sử dụng máy đã thanh lý (hồi sinh giữ/đổi mã) — VĐ2.
  const [reuseTarget, setReuseTarget] = useState<AssetRow | null>(null);
  // Tìm/lọc server-side (2.2): searchInput gõ tự do → search sau debounce 300ms
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState(() => {
    const s = searchParams.get('status') ?? '';
    // Bỏ 'disposed' — máy thanh lý ở Kho thanh lý riêng, không lọc trong sổ tài sản.
    return ['in_use', 'locked_repair'].includes(s) ? s : '';
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
  const [meta, setMeta] = useState<{ types: string[] }>({ types: [] });
  // Sắp xếp server-side (P1): DataTable controlled → map sang ?sort=&dir= → refetch.
  const [sorting, setSorting] = useState<SortingState>([]);
  // 5.1: chọn nhiều dòng để "Xuất đã chọn". Chỉ dùng ở sổ tài sản (không phải phần mềm).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bulk cho máy (mọi trạng thái) + phần mềm chưa thanh lý (chi tiết license → Thanh lý hàng loạt).
  const bulkSelectable = !softwareOnly || !disposedOnly;
  // Xác nhận Xóa vĩnh viễn (Kho thanh lý) — 1 dòng (có label) hoặc nhiều dòng đã chọn.
  const [purgeTarget, setPurgeTarget] = useState<
    { ids: string[]; label?: string } | null
  >(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  // Xác nhận Thanh lý phần mềm (→ Kho thanh lý) — 1 bản (có label) hoặc nhiều bản đã chọn.
  const [disposeTarget, setDisposeTarget] = useState<
    { ids: string[]; label?: string } | null
  >(null);
  const [disposeBusy, setDisposeBusy] = useState(false);
  // Xem chi tiết 1 bản phần mềm (popup read-only giống Sửa) — click dòng ở chi tiết license.
  const [viewForm, setViewForm] = useState<FormState | null>(null);
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
        excludeDisposed: softwareOnly && !disposedOnly,
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
      // Mọi danh sách trừ Kho thanh lý: ẩn bản/máy đã thanh lý (đã sang Kho thanh lý).
      if (!disposedOnly) params.set('excludeDisposed', 'true');
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
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const { openEdit, copyFrom, handleDelete, purgeById, disposeById } =
    useAssetPageActions({
      me,
      setForm,
      setError,
      queryClient,
      loadMeta,
    });

  // Chạy purge sau khi xác nhận: gộp bulk, invalidate 1 lần, tóm tắt lỗi nếu có dòng hỏng.
  const runPurge = async () => {
    if (!purgeTarget) return;
    const ids = purgeTarget.ids;
    setPurgeBusy(true);
    setError(null);
    const results = await Promise.all(ids.map((id) => purgeById(id)));
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.length - okCount;
    const failedIds = ids.filter((_, i) => !results[i].ok);
    setPurgeBusy(false);
    setPurgeTarget(null);
    // Giữ dòng LỖI được chọn (chỉ trong tập đã chọn trước đó) để thử lại; dòng thành công bỏ chọn.
    setSelected((prev) => new Set(failedIds.filter((id) => prev.has(id))));
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
    void loadMeta();
    if (failed > 0) {
      setError(
        results.length === 1
          ? (results[0].error ?? t('assets.deleteFailed'))
          : t('assets.purgeBulkPartial', {
              ok: okCount,
              total: results.length,
              failed,
            }),
      );
    }
  };

  // Thanh lý phần mềm (→ Kho thanh lý): giống runPurge nhưng dùng dispose; invalidate cả nhóm.
  const runDispose = async () => {
    if (!disposeTarget) return;
    const ids = disposeTarget.ids;
    setDisposeBusy(true);
    setError(null);
    const results = await Promise.all(ids.map((id) => disposeById(id)));
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.length - okCount;
    const failedIds = ids.filter((_, i) => !results[i].ok);
    setDisposeBusy(false);
    setDisposeTarget(null);
    // Giữ dòng LỖI được chọn (trong tập đã chọn) để thử lại; dòng thành công bỏ chọn.
    setSelected((prev) => new Set(failedIds.filter((id) => prev.has(id))));
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
    void queryClient.invalidateQueries({ queryKey: ['software-groups'] });
    if (failed > 0) {
      setError(
        results.length === 1
          ? (results[0].error ?? t('assets.saveFailed'))
          : t('assets.disposeBulkPartial', {
              ok: okCount,
              total: results.length,
              failed,
            }),
      );
    }
  };

  // Popup xem chi tiết 1 bản (read-only): lấy detail tươi → mở AssetForm khóa input.
  const openView = async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
      if (!res.ok) {
        setError(t('assets.loadFailed'));
        return;
      }
      setViewForm(detailToForm((await res.json()) as AssetDetail));
    } catch {
      setError(t('app.serverUnreachable'));
    }
  };

  // Vòng đời máy (Khóa sửa chữa/Mở khóa/Pool) TỪ kebab — thay khối Vòng đời trong form.
  const lifecycle = useAssetLifecycle({
    me,
    onChanged: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      void loadMeta();
    },
  });

  const columns = useAssetColumns({
    softwareOnly,
    disposedOnly,
    openEdit,
    copyFrom,
    onReuse: (row) => setReuseTarget(row),
    handleDelete,
    onPurge: (row) =>
      setPurgeTarget({
        ids: [row.id],
        label: row.code ?? row.licenseName ?? undefined,
      }),
    onDispose: (row) =>
      setDisposeTarget({
        ids: [row.id],
        label: row.installedOnCode ?? row.licenseName ?? undefined,
      }),
    setTransferSw,
    setTransferOwner,
    lifecycleActionsFor: lifecycle.actionsFor,
  });

  const clearAllFilters = () => {
    setSearchInput('');
    setSearch('');
    setType('');
    setStatus('');
    setExpiring(false);
    setEndFrom('');
    setEndTo('');
    setPage(1);
  };

  return (
    <>
      {licenseName && (
        <p style={{ marginBottom: '0.5rem' }}>
          <Link to="/software">‹ {t('software.backToGroups')}</Link>
        </p>
      )}
      <AssetsPageHeader
        licenseName={licenseName}
        softwareOnly={softwareOnly}
        disposedOnly={disposedOnly}
        search={search}
        type={type}
        status={status}
        expiring={expiring}
        endFrom={endFrom}
        endTo={endTo}
        onAdd={() =>
          setForm(
            softwareOnly
              ? { ...EMPTY_FORM, isSoftware: true, licenseName: licenseName ?? '' }
              : EMPTY_FORM,
          )
        }
        onImport={quickImport.pick}
      />
      <QuickImportSlot hook={quickImport} />
      {reuseTarget && (
        <ReactivateDialog
          me={me}
          asset={reuseTarget}
          onDone={(changed) => {
            setReuseTarget(null);
            if (changed) {
              void queryClient.invalidateQueries({ queryKey: ['assets'] });
              void loadMeta();
            }
          }}
        />
      )}
      {(error || listError) && (
        <p className="alert error">{error ?? t('assets.loadFailed')}</p>
      )}
      <AssetsFilterBar
        softwareOnly={softwareOnly}
        disposedOnly={disposedOnly}
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        type={type}
        setType={setType}
        types={meta.types}
        status={status}
        setStatus={setStatus}
        endFrom={endFrom}
        setEndFrom={setEndFrom}
        endTo={endTo}
        setEndTo={setEndTo}
        expiring={expiring}
        setExpiring={setExpiring}
        hasFilter={hasFilter}
        setPage={setPage}
        onClearAll={clearAllFilters}
      />
      {bulkSelectable && selected.size > 0 && (
        <div className="bulk-toolbar">
          <span className="bulk-count">
            {t('assets.selectedCount', { count: selected.size })}
          </span>
          {!softwareOnly && (
            <a
              className="linkbtn primary sm"
              href={`/api/admin/assets/export?ids=${[...selected].join(',')}`}
            >
              {t('assets.exportSelected', 'Xuất đã chọn')}
            </a>
          )}
          {disposedOnly && !softwareOnly && (
            <button
              type="button"
              className="danger sm"
              onClick={() => setPurgeTarget({ ids: [...selected] })}
            >
              {t('assets.purgeSelected', { count: selected.size })}
            </button>
          )}
          {softwareOnly && !disposedOnly && (
            <button
              type="button"
              className="danger sm"
              onClick={() => setDisposeTarget({ ids: [...selected] })}
            >
              {t('assets.disposeSelected', { count: selected.size })}
            </button>
          )}
          <button
            type="button"
            className="ghost sm"
            onClick={() => setSelected(new Set())}
          >
            {t('assets.clearSelection', 'Bỏ chọn')}
          </button>
        </div>
      )}
      <DataTable
        data={items}
        columns={columns}
        tableClassName={softwareOnly ? undefined : 'assets-table'}
        rowNumberOffset={(page - 1) * PAGE_SIZE}
        emptyText={hasFilter ? t('assets.noMatch') : t('assets.empty')}
        selection={
          bulkSelectable
            ? {
                selected,
                onToggle: (id) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  }),
                onToggleAll: (ids, checked) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    ids.forEach((id) =>
                      checked ? next.add(id) : next.delete(id),
                    );
                    return next;
                  }),
              }
            : undefined
        }
        manualSorting
        sorting={sorting}
        onSortingChange={onSortingChange}
        rowClassName={(a) =>
          a.id === seatParam ? 'row-highlight' : a.licenseWarning ? 'overdue' : ''
        }
        onRowClick={(a) => {
          // đang bôi đen copy mã → không phải ý định mở trang (review 2.2)
          if (window.getSelection()?.toString()) return;
          // Phần mềm: xem chi tiết bản = popup read-only (không chuyển trang). Máy: mở trang detail.
          if (softwareOnly) {
            void openView(a.id);
            return;
          }
          navigate(`/assets/${a.id}`);
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

      {purgeTarget && (
        <ConfirmDialog
          title={t('assets.purgeConfirmTitle')}
          message={
            purgeTarget.label
              ? t('assets.purgeConfirm', { code: purgeTarget.label })
              : t('assets.purgeConfirmBulk', { count: purgeTarget.ids.length })
          }
          confirmLabel={t('assets.purge')}
          danger
          busy={purgeBusy}
          onConfirm={() => void runPurge()}
          onCancel={() => setPurgeTarget(null)}
        />
      )}

      {disposeTarget && (
        <ConfirmDialog
          title={t('assets.disposeConfirmTitle', 'Thanh lý?')}
          message={
            disposeTarget.label
              ? t('assets.disposeConfirmOne', {
                  name: disposeTarget.label,
                  defaultValue:
                    'Thanh lý bản "{{name}}"? Bản sẽ chuyển sang Kho thanh lý và gỡ khỏi máy.',
                })
              : t('assets.disposeConfirmBulk', {
                  count: disposeTarget.ids.length,
                  defaultValue:
                    'Thanh lý {{count}} bản đã chọn? Chúng chuyển sang Kho thanh lý và gỡ khỏi máy.',
                })
          }
          confirmLabel={t('assets.disposeAction', 'Thanh lý')}
          danger
          busy={disposeBusy}
          onConfirm={() => void runDispose()}
          onCancel={() => setDisposeTarget(null)}
        />
      )}

      {viewForm && (
        <AssetForm
          me={me}
          initial={viewForm}
          lockSoftware={softwareOnly}
          readOnly
          onDone={() => setViewForm(null)}
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

      {/* Chuyển máy sang người khác (đổi người đứng tên) — phần mềm trên máy tự theo. */}
      {transferOwner && (
        <OwnerTransferDialog
          me={me}
          asset={transferOwner}
          onDone={(changed) => {
            setTransferOwner(null);
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

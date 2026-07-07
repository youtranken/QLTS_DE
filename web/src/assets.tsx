import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import type { Me } from './panels';

interface AssetRow {
  id: string;
  code: string;
  type: string;
  floor: string | null;
  status: string;
  isPool: boolean;
  assignedUserSub: string | null;
  assignedUserName: string | null;
  /** 2.5: license term sắp hết hạn đang gắn máy không-thanh-lý → dòng đỏ. */
  licenseWarning?: boolean;
}

interface AssetDetail extends AssetRow {
  configuration: string | null;
  cost: number | null;
  startDate: string | null;
  endDate: string | null;
  note: string | null;
  serial: string | null;
  brand: string | null;
  model: string | null;
  licenseType: string | null;
  licenseName: string | null;
  installedOnAssetId: string | null;
  installedOnCode: string | null;
  version: number;
}

interface FormState {
  id: string | null; // null = tạo mới
  version: number;
  status: string; // đổi qua khối Vòng đời (2.6), không qua form
  isPool: boolean;
  code: string;
  type: string;
  configuration: string;
  cost: string;
  startDate: string;
  endDate: string;
  floor: string;
  note: string;
  serial: string;
  brand: string;
  model: string;
  assignedUserSub: string;
  assignedUserName: string;
  // Software (2.4): isSoftware quyết định type='software' cứng + các trường license
  isSoftware: boolean;
  licenseType: string;
  licenseName: string;
  installedOnAssetId: string;
  installedOnCode: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  version: 1,
  status: 'in_use',
  isPool: false,
  code: '',
  type: '',
  configuration: '',
  cost: '',
  startDate: '',
  endDate: '',
  floor: '',
  note: '',
  serial: '',
  brand: '',
  model: '',
  assignedUserSub: '',
  assignedUserName: '',
  isSoftware: false,
  licenseType: '',
  licenseName: '',
  installedOnAssetId: '',
  installedOnCode: '',
};

const PAGE_SIZE = 20;

/** Trạng thái tài sản → lớp badge màu (vòng đời: đang dùng/khóa/thanh lý). */
const STATUS_BADGE: Record<string, string> = {
  in_use: 'ok',
  locked_repair: 'warn',
  disposed: 'muted',
};

/** 3.13: preview cascade (dry-run) — booking sẽ hủy + ticket in_use cần thu hồi. */
interface CascadePreview {
  futureCancellations: Array<{
    ticketId: string;
    borrowerName: string | null;
    from: string | null;
    to: string | null;
    state: string;
  }>;
  inUseRecalls: Array<{
    ticketId: string;
    borrowerName: string | null;
    from: string | null;
    to: string | null;
  }>;
}
/** Thao tác vòng đời đang chờ Admin xác nhận trong popup. */
interface PendingCascade {
  path: string;
  method: 'POST' | 'PUT';
  extra: Record<string, unknown>;
  patch: Partial<FormState>;
  data: CascadePreview;
}

const fmtDateTime = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** Sổ tài sản (story 2.1) — danh sách phân trang + form thêm/sửa. Admin/SA. */
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
  const [floor, setFloor] = useState('');
  const [meta, setMeta] = useState<{ types: string[]; floors: string[] }>({
    types: [],
    floors: [],
  });
  const hasFilter = search !== '' || type !== '' || status !== '' || floor !== '';

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
      const body = (await res.json()) as { types?: string[]; floors?: string[] };
      const types = body.types ?? [];
      const floors = body.floors ?? [];
      setMeta({ types, floors });
      // filter mồ côi (giá trị vừa biến mất khỏi sổ) → reset, tránh dropdown
      // trông như "tất cả" nhưng danh sách vẫn bị lọc (review 2.2)
      setType((v) => (v && !types.includes(v) ? '' : v));
      setFloor((v) => (v && !floors.includes(v) ? '' : v));
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
        if (floor) params.set('floor', floor);
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
    [page, search, type, status, floor, t],
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
        {!form && (
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
                ...(floor ? { floor } : {}),
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
          </>
        )}
      </div>
      {error && <p className="alert error">{error}</p>}
      {form ? (
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
      ) : (
        <>
          <div className="toolbar">
            <input
              className="grow"
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
            <select
              value={floor}
              onChange={(e) => {
                setFloor(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('assets.filterFloor')}</option>
              {meta.floors.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {hasFilter && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setSearch('');
                  setType('');
                  setStatus('');
                  setFloor('');
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
                  <th>{t('assets.floor')}</th>
                  <th>{t('assets.statusLabel')}</th>
                  <th>{t('assets.pool')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  // click dòng → xem chi tiết (AC 1; trang 3 tab là 2.7 — tạm mở form đủ trường)
                  <tr
                    key={a.id}
                    // FR-38: license sắp hết hạn → viền trái đỏ (class overdue)
                    className={a.licenseWarning ? 'overdue' : undefined}
                    onClick={() => {
                      // đang bôi đen copy mã → không phải ý định mở trang (review 2.2)
                      if (window.getSelection()?.toString()) return;
                      // 2.7: click dòng → trang chi tiết 3 tab (trỏ lại như hẹn ở 2.2)
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
                    <td>
                      {a.type === 'software' ? t('assets.kindSoftware') : a.type}
                    </td>
                    <td>{a.assignedUserName ?? a.assignedUserSub ?? '—'}</td>
                    <td>{a.floor ?? '—'}</td>
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
        </>
      )}
    </>
  );
}

interface AllocationRow {
  id: string;
  fromUserSub: string | null;
  fromUserName: string | null;
  toUserSub: string | null;
  toUserName: string | null;
  note: string | null;
  actor: string;
  actorName: string | null;
  createdAt: string;
}

function detailToForm(a: AssetDetail): FormState {
  return {
    id: a.id,
    version: a.version,
    status: a.status,
    isPool: a.isPool,
    code: a.code,
    type: a.type,
    configuration: a.configuration ?? '',
    cost: a.cost == null ? '' : String(a.cost),
    startDate: a.startDate ?? '',
    endDate: a.endDate ?? '',
    floor: a.floor ?? '',
    note: a.note ?? '',
    serial: a.serial ?? '',
    brand: a.brand ?? '',
    model: a.model ?? '',
    assignedUserSub: a.assignedUserSub ?? '',
    assignedUserName: a.assignedUserName ?? '',
    isSoftware: a.type === 'software',
    licenseType: a.licenseType ?? '',
    licenseName: a.licenseName ?? '',
    installedOnAssetId: a.installedOnAssetId ?? '',
    installedOnCode: a.installedOnCode ?? '',
  };
}

interface UserOption {
  sub: string;
  fullName: string | null;
  email: string | null;
}

/** Form thêm/sửa (FR-30). status/pool KHÔNG sửa ở đây — nghiệp vụ 2.6. */
function AssetForm({
  me,
  initial,
  onDone,
}: {
  me: Me;
  initial: FormState;
  onDone: (saved: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [form, setForm] = useState(initial);
  const [userQuery, setUserQuery] = useState('');
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  // 2.5/2.6: đã đổi qua endpoint phụ (transfer/vòng đời) → Hủy vẫn refresh danh sách
  const [transferred, setTransferred] = useState(false);
  // 2.6: form khóa máy (lý do bắt buộc + ETA tùy chọn)
  const [showLockForm, setShowLockForm] = useState(false);
  const [lockReason, setLockReason] = useState('');
  const [lockEta, setLockEta] = useState('');
  // 3.13: popup xác nhận cascade + cờ báo mail (preview trước khi Khóa/Gỡ pool/Thanh lý)
  const [cascade, setCascade] = useState<PendingCascade | null>(null);
  const [notifyUsers, setNotifyUsers] = useState(true);
  // 2.3: ghi chú cấp phát (chỉ dùng khi đổi người) + lịch sử A→B chỉ đọc
  const [allocationNote, setAllocationNote] = useState('');
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  // 2.4: picker máy cài (chỉ khi TẠO software) + software đã cài (khi sửa máy)
  const [hostQuery, setHostQuery] = useState('');
  const [hostOptions, setHostOptions] = useState<AssetRow[]>([]);
  const [installedSoftware, setInstalledSoftware] = useState<
    Array<{
      id: string;
      code: string;
      licenseType: string | null;
      licenseName: string | null;
      endDate: string | null;
    }>
  >([]);

  useEffect(() => {
    if (!hostQuery) {
      setHostOptions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/assets?search=${encodeURIComponent(hostQuery)}&page=1&pageSize=20`,
        { signal: controller.signal },
      )
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { items?: AssetRow[] };
          // chỉ máy: không phải software, không thanh lý (server chặn lại lần cuối);
          // loại máy ĐANG gắn — transfer vào chính nó là no-op nhiễu audit (review 2.5)
          setHostOptions(
            (body.items ?? []).filter(
              (a) =>
                a.type !== 'software' &&
                a.status !== 'disposed' &&
                a.id !== form.installedOnAssetId,
            ),
          );
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [hostQuery, form.installedOnAssetId]);

  useEffect(() => {
    if (!form.id || form.isSoftware) return;
    const controller = new AbortController();
    fetch(`/api/admin/assets/${encodeURIComponent(form.id)}/software`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.ok) {
          setInstalledSoftware(
            (await res.json()) as typeof installedSoftware,
          );
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [form.id, form.isSoftware]);

  useEffect(() => {
    if (!form.id) return;
    const controller = new AbortController();
    fetch(`/api/admin/assets/${encodeURIComponent(form.id)}/allocations`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.ok) setAllocations((await res.json()) as AllocationRow[]);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [form.id]);

  // STALE_VERSION: nạp lại bản mới nhất (version mới) ngay tại form — không mất chỗ đứng
  const reload = useCallback(async () => {
    if (!form.id) return;
    try {
      const res = await fetch(`/api/admin/assets/${encodeURIComponent(form.id)}`);
      if (!res.ok) return;
      setForm(detailToForm((await res.json()) as AssetDetail));
      setError(null);
      setStale(false);
    } catch {
      setError(t('app.serverUnreachable'));
    }
  }, [form.id, t]);

  // tìm người đứng tên server-side (users có thể ~3.000 — không tải hết)
  useEffect(() => {
    if (!userQuery) {
      setUserOptions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/users?search=${encodeURIComponent(userQuery)}&page=1&pageSize=20`,
        { signal: controller.signal },
      )
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { items?: UserOption[] };
          setUserOptions(body.items ?? []);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [userQuery]);

  const set = (key: keyof FormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    const payload: Record<string, unknown> = {
      code: form.code,
      type: form.isSoftware ? 'software' : form.type,
      configuration: form.configuration || null,
      cost: form.cost === '' ? null : Number(form.cost),
      startDate: form.startDate || null,
      // perpetual không có hạn — không gửi endDate còn sót lại trong state
      endDate:
        form.isSoftware && form.licenseType === 'perpetual'
          ? null
          : form.endDate || null,
      floor: form.floor || null,
      note: form.note || null,
      serial: form.serial || null,
      brand: form.brand || null,
      model: form.model || null,
      assignedUserSub: form.assignedUserSub || null,
      licenseType: form.isSoftware ? form.licenseType || null : null,
      // term cũng được có tên license — không xóa ngầm khi sửa (review 2.4)
      licenseName: form.isSoftware ? form.licenseName || null : null,
    };
    if (form.id) {
      payload.version = form.version;
      if (allocationNote.trim()) payload.allocationNote = allocationNote.trim();
    } else if (form.isSoftware && form.installedOnAssetId) {
      // gắn máy CHỈ khi tạo (AC 3) — đổi/gỡ là chức năng chuyển license (2.5)
      payload.installedOnAssetId = form.installedOnAssetId;
    }
    try {
      const res = await fetch(
        form.id
          ? `/api/admin/assets/${encodeURIComponent(form.id)}`
          : '/api/admin/assets',
        {
          method: form.id ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify(payload),
        },
      );
      if (res.ok) {
        onDone(true);
        return;
      }
      const body = (await res.json()) as { code?: string; message?: string };
      if (body.code === 'STALE_VERSION') {
        setError(t('assets.staleVersion'));
        setStale(true);
      } else if (body.code === 'CODE_TAKEN') {
        setError(t('assets.codeTaken'));
      } else {
        setError(body.message ?? t('assets.saveFailed'));
      }
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [form, allocationNote, me.csrfToken, onDone, t]);

  // 2.6: 4 thao tác vòng đời — chỉ cập nhật version + trường đổi (bài học 2.5)
  const doLifecycle = useCallback(
    async (
      path: string,
      method: 'POST' | 'PUT',
      extra: Record<string, unknown>,
      patch: Partial<FormState>,
    ) => {
      if (!form.id) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(form.id)}/${path}`,
          {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({ ...extra, version: form.version }),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { version: number };
          setTransferred(true);
          setForm((f) => ({ ...f, ...patch, version: body.version }));
          setShowLockForm(false);
          setLockReason('');
          setLockEta('');
          if (path === 'dispose') setInstalledSoftware([]); // license đã tự gỡ
          return;
        }
        const body = (await res.json()) as { code?: string; message?: string };
        if (body.code === 'STALE_VERSION') {
          setError(t('assets.staleVersion'));
          setStale(true);
        } else {
          setError(body.message ?? t('assets.saveFailed'));
        }
      } catch {
        setError(t('app.serverUnreachable'));
      } finally {
        setBusy(false);
      }
    },
    [form.id, form.version, me.csrfToken, t],
  );

  /**
   * 3.13: Khóa/Gỡ pool/Thanh lý → lấy PREVIEW trước. Có booking/ticket bị ảnh hưởng thì mở
   * popup cho Admin xem + xác nhận (kèm tick báo mail); không có gì thì chạy thẳng.
   * Preview lỗi → không chặn thao tác, chạy thẳng (notify mặc định true ở server).
   */
  const previewThenRun = useCallback(
    async (
      path: string,
      method: 'POST' | 'PUT',
      extra: Record<string, unknown>,
      patch: Partial<FormState>,
    ) => {
      if (!form.id) return;
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(form.id)}/lifecycle-preview`,
        );
        if (res.ok) {
          const data = (await res.json()) as CascadePreview;
          if (
            data.futureCancellations.length > 0 ||
            data.inUseRecalls.length > 0
          ) {
            setNotifyUsers(true);
            setCascade({ path, method, extra, patch, data });
            return;
          }
        }
      } catch {
        // preview hỏng → không chặn; chạy thẳng
      }
      void doLifecycle(path, method, extra, patch);
    },
    [form.id, doLifecycle],
  );

  // 2.5: chuyển license sang máy khác / gỡ về "chưa gắn máy" — endpoint riêng
  const transfer = useCallback(
    async (target: { id: string; code: string } | null) => {
      if (!form.id) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(form.id)}/transfer`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({
              ...(target ? { targetAssetId: target.id } : {}),
              version: form.version,
            }),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { version: number };
          setHostQuery('');
          setHostOptions([]);
          setTransferred(true);
          // chỉ cập nhật version + máy — KHÔNG reload cả form (mất dữ liệu đang gõ, review 2.5)
          setForm((f) => ({
            ...f,
            version: body.version,
            installedOnAssetId: target?.id ?? '',
            installedOnCode: target?.code ?? '',
          }));
          return;
        }
        const body = (await res.json()) as { code?: string; message?: string };
        if (body.code === 'STALE_VERSION') {
          setError(t('assets.staleVersion'));
          setStale(true);
        } else {
          setError(body.message ?? t('assets.transferFailed'));
        }
      } catch {
        setError(t('app.serverUnreachable'));
      } finally {
        setBusy(false);
      }
    },
    [form.id, form.version, me.csrfToken, t],
  );

  const grid: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '0.75rem',
    maxWidth: 960,
  };

  return (
    <section>
      <div className="page-header">
        <h1>
          {form.id ? t('assets.editTitle', { code: initial.code }) : t('assets.addAsset')}
        </h1>
      </div>
      {error && (
        <p className="alert error">
          {error}{' '}
          {stale && (
            <button type="button" onClick={() => void reload()}>
              {t('assets.reload')}
            </button>
          )}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!form.id && (
          // chọn bản chất bản ghi khi TẠO — sửa không đổi được (TYPE_SOFTWARE_IMMUTABLE)
          <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '1rem' }}>
            <label>
              <input
                type="radio"
                name="kind"
                checked={!form.isSoftware}
                onChange={() =>
                  setForm((f) => ({
                    ...f,
                    isSoftware: false,
                    licenseType: '',
                    licenseName: '',
                    installedOnAssetId: '',
                    installedOnCode: '',
                  }))
                }
              />{' '}
              {t('assets.kindDevice')}
            </label>
            <label>
              <input
                type="radio"
                name="kind"
                checked={form.isSoftware}
                onChange={() => setForm((f) => ({ ...f, isSoftware: true }))}
              />{' '}
              {t('assets.kindSoftware')}
            </label>
          </div>
        )}
        <div style={grid}>
          <label className="field">
            {t('assets.code')} *
            <input
              required
              maxLength={100}
              value={form.code}
              onChange={(e) => set('code')(e.target.value)}
            />
          </label>
          {!form.isSoftware && (
            <label className="field">
              {t('assets.type')} *
              <input
                required
                maxLength={100}
                value={form.type}
                onChange={(e) => set('type')(e.target.value)}
              />
            </label>
          )}
          {form.isSoftware && (
            <label className="field">
              {t('assets.licenseType')} *
              <select
                required
                value={form.licenseType}
                onChange={(e) => set('licenseType')(e.target.value)}
              >
                <option value="">—</option>
                <option value="term">{t('assets.licenseTerm')}</option>
                <option value="perpetual">{t('assets.licensePerpetual')}</option>
              </select>
            </label>
          )}
          {form.isSoftware && form.licenseType && (
            <label className="field">
              {t('assets.licenseName')}
              {form.licenseType === 'perpetual' && ' *'}
              <input
                required={form.licenseType === 'perpetual'}
                maxLength={200}
                value={form.licenseName}
                onChange={(e) => set('licenseName')(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            {t('assets.configuration')}
            <input
              maxLength={2000}
              value={form.configuration}
              onChange={(e) => set('configuration')(e.target.value)}
            />
          </label>
          <label className="field">
            {t('assets.cost')}
            <input
              type="number"
              min={0}
              step={1}
              value={form.cost}
              onChange={(e) => set('cost')(e.target.value)}
            />
          </label>
          <label className="field">
            {t('assets.startDate')}
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => set('startDate')(e.target.value)}
            />
          </label>
          {!(form.isSoftware && form.licenseType === 'perpetual') && (
            <label className="field">
              {t('assets.endDate')}
              {form.isSoftware && form.licenseType === 'term' && ' *'}
              <input
                type="date"
                required={form.isSoftware && form.licenseType === 'term'}
                value={form.endDate}
                onChange={(e) => set('endDate')(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            {t('assets.floor')}
            <input
              maxLength={50}
              value={form.floor}
              onChange={(e) => set('floor')(e.target.value)}
            />
          </label>
          <label className="field">
            {t('assets.statusLabel')}
            {/* Chỉ hiển thị (AC 1) — khóa/gỡ pool/thanh lý là nghiệp vụ 2.6 */}
            <input disabled value={t(`assets.status.${form.status}`)} />
          </label>
          <label className="field">
            {t('assets.serial')}
            <input
              maxLength={200}
              value={form.serial}
              onChange={(e) => set('serial')(e.target.value)}
            />
          </label>
          <label className="field">
            {t('assets.brand')}
            <input
              maxLength={200}
              value={form.brand}
              onChange={(e) => set('brand')(e.target.value)}
            />
          </label>
          <label className="field">
            {t('assets.model')}
            <input
              maxLength={200}
              value={form.model}
              onChange={(e) => set('model')(e.target.value)}
            />
          </label>
          <label className="field">
            {t('assets.note')}
            <input
              maxLength={2000}
              value={form.note}
              onChange={(e) => set('note')(e.target.value)}
            />
          </label>
        </div>
        {form.id && (
          // 2.6: vòng đời — 3 thao tác tách bạch, không đi qua nút Lưu
          <div style={{ marginTop: '0.75rem' }}>
            <h3 style={{ margin: '0 0 0.25rem' }}>
              {t('assets.lifecycle')}
            </h3>
            {form.status === 'disposed' ? (
              <p className="muted">
                {t('assets.disposedTerminal')}
              </p>
            ) : (
              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                {!form.isSoftware && form.status === 'in_use' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setShowLockForm((v) => !v)}
                  >
                    {t('assets.lockAction')}
                  </button>
                )}
                {!form.isSoftware && form.status === 'locked_repair' && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void doLifecycle('unlock', 'POST', {}, { status: 'in_use' })
                    }
                  >
                    {t('assets.unlockAction')}
                  </button>
                )}
                {!form.isSoftware && form.status === 'in_use' && (
                  // pool toggle CHỈ khi in_use — đụng pool lúc đang khóa phá
                  // invariant "mở khóa → pool như trước" (review 2.6)
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const next = !form.isPool;
                      // Gỡ pool (next=false) → cascade → preview+popup; bật pool → chạy thẳng
                      const run = next ? doLifecycle : previewThenRun;
                      void run('pool', 'PUT', { isPool: next }, { isPool: next });
                    }}
                  >
                    {form.isPool ? t('assets.poolOff') : t('assets.poolOn')}
                  </button>
                )}
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    // Thanh lý không đảo ngược → giữ window.confirm (AC2); rồi preview+popup
                    if (window.confirm(t('assets.disposeConfirm'))) {
                      void previewThenRun(
                        'dispose',
                        'POST',
                        {},
                        {
                          status: 'disposed',
                          installedOnAssetId: '',
                          installedOnCode: '',
                        },
                      );
                    }
                  }}
                >
                  {t('assets.disposeAction')}
                </button>
              </div>
            )}
            {showLockForm && form.status === 'in_use' && (
              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                  marginTop: '0.5rem',
                }}
              >
                <label className="field">
                  {t('assets.lockReason')} *
                  <input
                    maxLength={500}
                    value={lockReason}
                    onChange={(e) => setLockReason(e.target.value)}
                  />
                </label>
                <label className="field">
                  {t('assets.lockEta')}
                  <input
                    type="date"
                    value={lockEta}
                    onChange={(e) => setLockEta(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !lockReason.trim()}
                  onClick={() =>
                    void previewThenRun(
                      'lock',
                      'POST',
                      {
                        reason: lockReason.trim(),
                        ...(lockEta ? { eta: lockEta } : {}),
                      },
                      { status: 'locked_repair' },
                    )
                  }
                >
                  {t('assets.confirmLock')}
                </button>
              </div>
            )}
          </div>
        )}
        <div style={{ marginTop: '0.75rem', maxWidth: 480 }}>
          <p style={{ margin: '0 0 0.25rem' }}>
            {t('assets.assignee')}:{' '}
            <strong>
              {form.assignedUserSub
                ? form.assignedUserName || form.assignedUserSub
                : t('assets.assigneeEmpty')}
            </strong>
            {form.assignedUserSub && (
              <button
                type="button"
                style={{ marginLeft: '0.5rem' }}
                onClick={() => {
                  set('assignedUserSub')('');
                  set('assignedUserName')('');
                }}
              >
                ✕
              </button>
            )}
          </p>
          <input
            placeholder={t('assets.assigneeSearch')}
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
          />
          {userOptions.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0.25rem 0' }}>
              {userOptions.map((u) => (
                <li key={u.sub}>
                  <button
                    type="button"
                    style={{ margin: '0.1rem 0' }}
                    onClick={() => {
                      setForm((f) => ({
                        ...f,
                        assignedUserSub: u.sub,
                        assignedUserName: u.fullName ?? u.sub,
                      }));
                      setUserQuery('');
                      setUserOptions([]);
                    }}
                  >
                    {u.fullName ?? u.sub} {u.email ? `(${u.email})` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* software disposed: TERMINAL — không gắn/chuyển được nữa (review 2.6) */}
          {form.isSoftware && form.status !== 'disposed' && (
            <div style={{ marginTop: '0.75rem' }}>
              <p style={{ margin: '0 0 0.25rem' }}>
                {t('assets.installedOn')}:{' '}
                <strong>
                  {form.installedOnAssetId
                    ? form.installedOnCode || form.installedOnAssetId
                    : t('assets.installedNone')}
                </strong>
                {!form.id && form.installedOnAssetId && (
                  <button
                    type="button"
                    style={{ marginLeft: '0.5rem' }}
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        installedOnAssetId: '',
                        installedOnCode: '',
                      }))
                    }
                  >
                    ✕
                  </button>
                )}
              </p>
              {form.id && form.installedOnAssetId && (
                // 2.5: gỡ về "chưa gắn máy" — thao tác thật, có audit
                <button
                  type="button"
                  disabled={busy}
                  style={{ marginBottom: '0.25rem' }}
                  onClick={() => void transfer(null)}
                >
                  {t('assets.detach')}
                </button>
              )}
              <input
                placeholder={
                  form.id
                    ? t('assets.transferToSearch')
                    : t('assets.installedOnSearch')
                }
                value={hostQuery}
                onChange={(e) => setHostQuery(e.target.value)}
              />
              {hostOptions.length > 0 && (
                <ul
                  style={{ listStyle: 'none', padding: 0, margin: '0.25rem 0' }}
                >
                  {hostOptions.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        disabled={busy}
                        style={{ margin: '0.1rem 0' }}
                        onClick={() => {
                          if (form.id) {
                            // sửa: chuyển NGAY qua endpoint transfer (2.5)
                            void transfer({ id: a.id, code: a.code });
                            return;
                          }
                          setForm((f) => ({
                            ...f,
                            installedOnAssetId: a.id,
                            installedOnCode: a.code,
                          }));
                          setHostQuery('');
                          setHostOptions([]);
                        }}
                      >
                        {a.code} — {a.type}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {form.id && (
            <label className="field" style={{ marginTop: '0.5rem' }}>
              {t('assets.allocationNote')}
              <input
                maxLength={500}
                placeholder={t('assets.allocationNotePlaceholder')}
                value={allocationNote}
                onChange={(e) => setAllocationNote(e.target.value)}
              />
            </label>
          )}
        </div>
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
          {/* disposed = hồ sơ đã chốt (F2) — server cũng chặn 409 DISPOSED_TERMINAL */}
          <button
            type="submit"
            className="primary"
            disabled={busy || (!!form.id && form.status === 'disposed')}
          >
            {t('assets.save')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDone(transferred)}
          >
            {t('assets.cancel')}
          </button>
        </div>
      </form>
      {form.id && !form.isSoftware && installedSoftware.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <h3>
            {t('assets.installedSoftware')}
          </h3>
          <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
            {installedSoftware.map((s) => (
              <li key={s.id}>
                {s.code}
                {s.licenseType === 'perpetual'
                  ? ` — ${s.licenseName ?? ''} (${t('assets.licensePerpetual')})`
                  : s.endDate
                    ? ` — ${t('assets.endDate')}: ${s.endDate}`
                    : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {form.id && allocations.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.5rem' }}>{t('assets.allocationHistory')}</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('assets.allocDate')}</th>
                  <th>{t('assets.allocFrom')}</th>
                  <th>{t('assets.allocTo')}</th>
                  <th>{t('assets.allocActor')}</th>
                  <th>{t('assets.note')}</th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((h) => (
                  <tr key={h.id}>
                    <td>
                      {/* theo ngôn ngữ UI đang chọn, không phải locale browser (review 2.3) */}
                      {new Date(h.createdAt).toLocaleString(
                        i18n.language === 'en' ? 'en-GB' : 'vi-VN',
                      )}
                    </td>
                    <td>
                      {h.fromUserSub
                        ? (h.fromUserName ?? h.fromUserSub)
                        : t('assets.stock')}
                    </td>
                    <td>
                      {h.toUserSub
                        ? (h.toUserName ?? h.toUserSub)
                        : t('assets.stock')}
                    </td>
                    <td>{h.actorName ?? h.actor}</td>
                    <td>{h.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3.13: popup xác nhận cascade — danh sách bị ảnh hưởng + cờ báo mail */}
      {cascade && (
        <div className="modal-backdrop" onClick={() => setCascade(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: '0.75rem' }}>{t('cascade.title')}</h2>

            {cascade.data.futureCancellations.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <h3 style={{ marginBottom: '0.4rem' }}>
                  {t('cascade.willCancel', {
                    n: cascade.data.futureCancellations.length,
                  })}
                </h3>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('cascade.colBorrower')}</th>
                        <th>{t('cascade.colTime')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cascade.data.futureCancellations.map((r) => (
                        // key kèm from: ticket recurring (Epic 4) có nhiều booking/máy → tránh trùng key
                        <tr key={`${r.ticketId}-${r.from ?? ''}`}>
                          <td>{r.borrowerName ?? '—'}</td>
                          <td>
                            {fmtDateTime(r.from)} → {fmtDateTime(r.to)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {cascade.data.inUseRecalls.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <h3 style={{ marginBottom: '0.4rem' }}>
                  {t('cascade.willRecall', {
                    n: cascade.data.inUseRecalls.length,
                  })}
                </h3>
                <p className="muted" style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}>
                  {t('cascade.recallHint')}
                </p>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('cascade.colBorrower')}</th>
                        <th>{t('cascade.colTime')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cascade.data.inUseRecalls.map((r) => (
                        <tr key={`${r.ticketId}-${r.from ?? ''}`}>
                          <td>{r.borrowerName ?? '—'}</td>
                          <td>
                            {fmtDateTime(r.from)} → {fmtDateTime(r.to)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                margin: '0.75rem 0 1.25rem',
              }}
            >
              <input
                type="checkbox"
                checked={notifyUsers}
                onChange={(e) => setNotifyUsers(e.target.checked)}
                style={{ width: 'auto' }}
              />
              {t('cascade.notify')}
            </label>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setCascade(null)}>
                {t('cascade.cancel')}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  const c = cascade;
                  setCascade(null);
                  void doLifecycle(
                    c.path,
                    c.method,
                    { ...c.extra, notify: notifyUsers },
                    c.patch,
                  );
                }}
              >
                {t('cascade.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

interface NoteRow {
  id: string;
  kind: string;
  note: string | null;
  eta: string | null;
  actor: string;
  actorName: string | null;
  createdAt: string;
}

/** Trang chi tiết máy 3 tab (story 2.7, UJ-3) — route /tai-san/:id. */
export function AssetDetailPage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'alloc' | 'loan' | 'notes'>('alloc');
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [handovers, setHandovers] = useState<
    Array<{
      ticketId: string;
      stateLabel: string;
      borrowerName: string | null;
      from: string;
      to: string;
      deliveredAt: string | null;
      returnedAt: string | null;
    }>
  >([]);
  const [handoverTotal, setHandoverTotal] = useState(0);
  const [handoverPage, setHandoverPage] = useState(1);
  const HANDOVER_PAGE_SIZE = 20;
  const [software, setSoftware] = useState<
    Array<{
      id: string;
      code: string;
      licenseType: string | null;
      licenseName: string | null;
      endDate: string | null;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!id) return;
    setError(null);
    setNotFound(false); // id đổi qua history không remount — không kẹt notFound cũ
    try {
      const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      if (res.status === 404 || res.status === 400) {
        // 400 = id không phải uuid (deep-link gõ tay) — cùng một thông báo
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        setError(t('assets.loadFailed'));
        return;
      }
      const a = (await res.json()) as AssetDetail;
      setDetail(a);
      const [allocRes, noteRes, swRes, hoRes] = await Promise.all([
        fetch(`/api/admin/assets/${encodeURIComponent(id)}/allocations`),
        fetch(`/api/admin/assets/${encodeURIComponent(id)}/notes`),
        a.type !== 'software'
          ? fetch(`/api/admin/assets/${encodeURIComponent(id)}/software`)
          : Promise.resolve(null),
        a.type !== 'software'
          ? fetch(`/api/admin/tickets/by-asset/${encodeURIComponent(id)}/handovers`)
          : Promise.resolve(null),
      ]);
      // fetch phụ lỗi phải HIỆN lỗi — "chưa có dữ liệu" khác "không tải được" (UJ-3)
      if (allocRes.ok) {
        setAllocations((await allocRes.json()) as AllocationRow[]);
      } else {
        setError(t('assets.loadFailed'));
      }
      if (noteRes.ok) {
        setNotes((await noteRes.json()) as NoteRow[]);
      } else {
        setError(t('assets.loadFailed'));
      }
      if (swRes) {
        if (swRes.ok) {
          setSoftware((await swRes.json()) as typeof software);
        } else {
          setError(t('assets.loadFailed'));
        }
      }
      if (hoRes) {
        if (hoRes.ok) {
          const body = (await hoRes.json()) as {
            items: typeof handovers;
            total: number;
          };
          setHandovers(body.items);
          setHandoverTotal(body.total);
        } else {
          setError(t('assets.loadFailed'));
        }
      }
    } catch {
      setError(t('app.serverUnreachable'));
    }
  }, [id, t]);

  const loadHandovers = useCallback(
    async (page: number) => {
      if (!id) return;
      const res = await fetch(
        `/api/admin/tickets/by-asset/${encodeURIComponent(id)}/handovers?page=${page}`,
      );
      if (res.ok) {
        const body = (await res.json()) as {
          items: typeof handovers;
          total: number;
        };
        setHandovers(body.items);
        setHandoverTotal(body.total);
        setHandoverPage(page);
      }
    },
    [id],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const fmtDateTime = (v: string) =>
    new Date(v).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN');

  if (notFound) {
    return (
      <>
        <p>{t('assets.notFound')}</p>
        <Link to="/tai-san">{t('assets.backToList')}</Link>
      </>
    );
  }
  if (!detail) {
    return <p>{error ?? t('app.checkingSession')}</p>;
  }
  if (editing) {
    return (
      <AssetForm
        me={me}
        initial={detailToForm(detail)}
        onDone={() => {
          setEditing(false);
          void loadAll(); // defer 2.3: chi tiết luôn refetch sau khi đóng form
        }}
      />
    );
  }

  const info: Array<[string, React.ReactNode]> = [
    [t('assets.code'), detail.code],
    [
      t('assets.type'),
      detail.type === 'software' ? t('assets.kindSoftware') : detail.type,
    ],
    [t('assets.statusLabel'), t(`assets.status.${detail.status}`)],
    [t('assets.configuration'), detail.configuration],
    [
      t('assets.cost'),
      detail.cost == null
        ? null
        : detail.cost.toLocaleString(
            i18n.language === 'en' ? 'en-GB' : 'vi-VN',
          ),
    ],
    [t('assets.startDate'), detail.startDate],
    [t('assets.endDate'), detail.endDate],
    [t('assets.floor'), detail.floor],
    [t('assets.serial'), detail.serial],
    [t('assets.brand'), detail.brand],
    [t('assets.model'), detail.model],
    [
      t('assets.assignee'),
      detail.assignedUserSub
        ? (detail.assignedUserName ?? detail.assignedUserSub)
        : t('assets.assigneeEmpty'),
    ],
    [t('assets.pool'), detail.isPool ? '✓' : '—'],
    [t('assets.note'), detail.note],
  ];
  if (detail.type === 'software') {
    info.push(
      [
        t('assets.licenseType'),
        detail.licenseType === 'term'
          ? t('assets.licenseTerm')
          : detail.licenseType === 'perpetual'
            ? t('assets.licensePerpetual')
            : null,
      ],
      [t('assets.licenseName'), detail.licenseName],
      [
        t('assets.installedOn'),
        detail.installedOnAssetId
          ? (detail.installedOnCode ?? detail.installedOnAssetId)
          : t('assets.installedNone'),
      ],
    );
  }

  const tabButton = (key: typeof tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      style={{
        padding: '0.4rem 0.85rem',
        borderRadius: 'var(--r-sm)',
        border: '1px solid transparent',
        fontWeight: 600,
        background: tab === key ? 'var(--primary-soft)' : 'transparent',
        color: tab === key ? 'var(--primary-ink)' : 'var(--ink-3)',
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/tai-san">‹ {t('assets.backToList')}</Link>
      </p>
      <div className="page-header">
        <h1>{detail.code}</h1>
        <button type="button" className="primary" onClick={() => setEditing(true)}>
          {t('assets.edit')}
        </button>
      </div>
      {error && <p className="alert error">{error}</p>}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '0.5rem 1.5rem',
          maxWidth: 960,
          margin: '0.75rem 0',
        }}
      >
        {info
          .filter(([, v]) => v != null && v !== '')
          .map(([label, value]) => (
            <div key={label}>
              <dt style={{ fontSize: '0.8rem', color: 'var(--ink-2)' }}>{label}</dt>
              <dd style={{ margin: 0 }}>{value}</dd>
            </div>
          ))}
      </dl>
      {detail.type !== 'software' && (
        <div style={{ margin: '0.75rem 0' }}>
          <h3 style={{ margin: '0 0 0.25rem' }}>
            {t('assets.installedSoftware')}
          </h3>
          {software.length === 0 ? (
            <p className="muted">
              {t('assets.noInstalledSoftware')}
            </p>
          ) : (
            <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
              {software.map((s) => (
                <li key={s.id}>
                  {s.code}
                  {s.licenseType === 'perpetual'
                    ? ` — ${s.licenseName ?? ''} (${t('assets.licensePerpetual')})`
                    : s.endDate
                      ? ` — ${t('assets.endDate')}: ${s.endDate}`
                      : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          gap: '0.25rem',
          borderBottom: '1px solid var(--border)',
          paddingBottom: '0.5rem',
          marginTop: '1rem',
        }}
      >
        {tabButton('alloc', t('assets.allocationHistory'))}
        {tabButton('loan', t('assets.loanTab'))}
        {tabButton('notes', t('assets.notesTab'))}
      </div>
      <div style={{ marginTop: '0.75rem' }}>
        {tab === 'alloc' &&
          (allocations.length === 0 ? (
            <p>{t('assets.noAllocations')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('assets.allocDate')}</th>
                    <th>{t('assets.allocFrom')}</th>
                    <th>{t('assets.allocTo')}</th>
                    <th>{t('assets.allocActor')}</th>
                    <th>{t('assets.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((h) => (
                    <tr key={h.id}>
                      <td>{fmtDateTime(h.createdAt)}</td>
                      <td>
                        {h.fromUserSub
                          ? (h.fromUserName ?? h.fromUserSub)
                          : t('assets.stock')}
                      </td>
                      <td>
                        {h.toUserSub
                          ? (h.toUserName ?? h.toUserSub)
                          : t('assets.stock')}
                      </td>
                      <td>{h.actorName ?? h.actor}</td>
                      <td>{h.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'loan' &&
          (handovers.length === 0 ? (
            <p>{t('assets.loanTabEmpty')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('assets.hoBorrower')}</th>
                    <th>{t('assets.hoWindow')}</th>
                    <th>{t('assets.hoDelivered')}</th>
                    <th>{t('assets.hoReturned')}</th>
                    <th>{t('assets.hoState')}</th>
                  </tr>
                </thead>
                <tbody>
                  {handovers.map((h) => (
                    <tr key={h.ticketId}>
                      <td>{h.borrowerName ?? '—'}</td>
                      <td>
                        {fmtDateTime(h.from)} → {fmtDateTime(h.to)}
                      </td>
                      <td>
                        {h.deliveredAt ? fmtDateTime(h.deliveredAt) : '—'}
                      </td>
                      <td>
                        {h.returnedAt ? fmtDateTime(h.returnedAt) : '—'}
                      </td>
                      <td>
                        <span className="badge muted">{h.stateLabel}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'loan' &&
          handoverTotal > HANDOVER_PAGE_SIZE && (
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: 8 }}>
              <button
                type="button"
                disabled={handoverPage <= 1}
                onClick={() => void loadHandovers(handoverPage - 1)}
              >
                ‹ {t('assets.prev')}
              </button>
              <span>
                {handoverPage} /{' '}
                {Math.ceil(handoverTotal / HANDOVER_PAGE_SIZE)}
              </span>
              <button
                type="button"
                disabled={handoverPage >= Math.ceil(handoverTotal / HANDOVER_PAGE_SIZE)}
                onClick={() => void loadHandovers(handoverPage + 1)}
              >
                {t('assets.next')} ›
              </button>
            </div>
          )}
        {tab === 'notes' &&
          (notes.length === 0 ? (
            <p>{t('assets.noNotes')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('assets.allocDate')}</th>
                    <th>{t('assets.noteKind')}</th>
                    <th>{t('assets.note')}</th>
                    <th>{t('assets.lockEta')}</th>
                    <th>{t('assets.allocActor')}</th>
                  </tr>
                </thead>
                <tbody>
                  {notes.map((n) => (
                    <tr key={n.id}>
                      <td>{fmtDateTime(n.createdAt)}</td>
                      <td>{t(`assets.noteKinds.${n.kind}`)}</td>
                      <td>{n.note}</td>
                      <td>{n.eta}</td>
                      <td>{n.actorName ?? n.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>
    </>
  );
}

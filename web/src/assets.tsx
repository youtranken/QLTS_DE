import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  status: string; // chỉ hiển thị (AC 1) — đổi trạng thái là nghiệp vụ 2.6
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

/** Sổ tài sản (story 2.1) — danh sách phân trang + form thêm/sửa. Admin/SA. */
export function AssetsPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AssetRow[]>([]);
  const [total, setTotal] = useState(0);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tìm/lọc server-side (2.2): searchInput gõ tự do → search sau debounce 300ms
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
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
  const cell: React.CSSProperties = { padding: '0.25rem 0.75rem' };

  return (
    <>
      <h1 style={{ fontSize: '1.2rem' }}>{t('nav.assets')}</h1>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
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
          <button type="button" onClick={() => setForm(EMPTY_FORM)}>
            {t('assets.addAsset')}
          </button>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginTop: '0.75rem',
            }}
          >
            <input
              placeholder={t('assets.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{ padding: '0.3rem 0.5rem', minWidth: 220 }}
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
          <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={cell}>{t('assets.code')}</th>
                  <th style={cell}>{t('assets.type')}</th>
                  <th style={cell}>{t('assets.assignee')}</th>
                  <th style={cell}>{t('assets.floor')}</th>
                  <th style={cell}>{t('assets.statusLabel')}</th>
                  <th style={cell}>{t('assets.pool')}</th>
                  <th style={cell}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  // click dòng → xem chi tiết (AC 1; trang 3 tab là 2.7 — tạm mở form đủ trường)
                  <tr
                    key={a.id}
                    onClick={() => {
                      // đang bôi đen copy mã → không phải ý định mở form (review 2.2)
                      if (window.getSelection()?.toString()) return;
                      void openEdit(a.id);
                    }}
                    style={{
                      cursor: 'pointer',
                      // FR-38: license sắp hết hạn — dòng đỏ
                      color: a.licenseWarning ? '#c0392b' : undefined,
                      fontWeight: a.licenseWarning ? 600 : undefined,
                    }}
                  >
                    <td style={cell}>{a.code}</td>
                    <td style={cell}>
                      {a.type === 'software' ? t('assets.kindSoftware') : a.type}
                    </td>
                    <td style={cell}>
                      {a.assignedUserName ?? a.assignedUserSub ?? ''}
                    </td>
                    <td style={cell}>{a.floor}</td>
                    <td style={cell}>{t(`assets.status.${a.status}`)}</td>
                    <td style={cell}>{a.isPool ? '✓' : ''}</td>
                    <td style={cell}>
                      <button
                        type="button"
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
            <p>{hasFilter ? t('assets.noMatch') : t('assets.empty')}</p>
          )}
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ‹ {t('assets.prev')}
            </button>
            <span>
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
          // chỉ máy: không phải software, không thanh lý (server chặn lại lần cuối)
          setHostOptions(
            (body.items ?? []).filter(
              (a) => a.type !== 'software' && a.status !== 'disposed',
            ),
          );
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [hostQuery]);

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

  // 2.5: chuyển license sang máy khác / gỡ về "chưa gắn máy" — endpoint riêng
  const transfer = useCallback(
    async (targetAssetId: string | null) => {
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
              ...(targetAssetId ? { targetAssetId } : {}),
              version: form.version,
            }),
          },
        );
        if (res.ok) {
          setHostQuery('');
          setHostOptions([]);
          await reload(); // nạp version + máy mới vào form
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
    [form.id, form.version, me.csrfToken, reload, t],
  );

  const field: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.15rem',
  };
  const grid: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '0.75rem',
    maxWidth: 960,
  };

  return (
    <section>
      <h2 style={{ fontSize: '1rem' }}>
        {form.id ? t('assets.editTitle', { code: initial.code }) : t('assets.addAsset')}
      </h2>
      {error && (
        <p style={{ color: '#c0392b' }}>
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
          <label style={field}>
            {t('assets.code')} *
            <input
              required
              maxLength={100}
              value={form.code}
              onChange={(e) => set('code')(e.target.value)}
            />
          </label>
          {!form.isSoftware && (
            <label style={field}>
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
            <label style={field}>
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
            <label style={field}>
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
          <label style={field}>
            {t('assets.configuration')}
            <input
              maxLength={2000}
              value={form.configuration}
              onChange={(e) => set('configuration')(e.target.value)}
            />
          </label>
          <label style={field}>
            {t('assets.cost')}
            <input
              type="number"
              min={0}
              step={1}
              value={form.cost}
              onChange={(e) => set('cost')(e.target.value)}
            />
          </label>
          <label style={field}>
            {t('assets.startDate')}
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => set('startDate')(e.target.value)}
            />
          </label>
          {!(form.isSoftware && form.licenseType === 'perpetual') && (
            <label style={field}>
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
          <label style={field}>
            {t('assets.floor')}
            <input
              maxLength={50}
              value={form.floor}
              onChange={(e) => set('floor')(e.target.value)}
            />
          </label>
          <label style={field}>
            {t('assets.statusLabel')}
            {/* Chỉ hiển thị (AC 1) — khóa/gỡ pool/thanh lý là nghiệp vụ 2.6 */}
            <input disabled value={t(`assets.status.${form.status}`)} />
          </label>
          <label style={field}>
            {t('assets.serial')}
            <input
              maxLength={200}
              value={form.serial}
              onChange={(e) => set('serial')(e.target.value)}
            />
          </label>
          <label style={field}>
            {t('assets.brand')}
            <input
              maxLength={200}
              value={form.brand}
              onChange={(e) => set('brand')(e.target.value)}
            />
          </label>
          <label style={field}>
            {t('assets.model')}
            <input
              maxLength={200}
              value={form.model}
              onChange={(e) => set('model')(e.target.value)}
            />
          </label>
          <label style={field}>
            {t('assets.note')}
            <input
              maxLength={2000}
              value={form.note}
              onChange={(e) => set('note')(e.target.value)}
            />
          </label>
        </div>
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
          {form.isSoftware && (
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
                            void transfer(a.id);
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
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.15rem',
                marginTop: '0.5rem',
              }}
            >
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
          <button type="submit" disabled={busy}>
            {t('assets.save')}
          </button>
          <button type="button" disabled={busy} onClick={() => onDone(false)}>
            {t('assets.cancel')}
          </button>
        </div>
      </form>
      {form.id && !form.isSoftware && installedSoftware.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <h3 style={{ fontSize: '0.95rem' }}>
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
          <h3 style={{ fontSize: '0.95rem' }}>{t('assets.allocationHistory')}</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ padding: '0.25rem 0.75rem' }}>
                    {t('assets.allocDate')}
                  </th>
                  <th style={{ padding: '0.25rem 0.75rem' }}>
                    {t('assets.allocFrom')}
                  </th>
                  <th style={{ padding: '0.25rem 0.75rem' }}>
                    {t('assets.allocTo')}
                  </th>
                  <th style={{ padding: '0.25rem 0.75rem' }}>
                    {t('assets.allocActor')}
                  </th>
                  <th style={{ padding: '0.25rem 0.75rem' }}>
                    {t('assets.note')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((h) => (
                  <tr key={h.id}>
                    <td style={{ padding: '0.25rem 0.75rem' }}>
                      {/* theo ngôn ngữ UI đang chọn, không phải locale browser (review 2.3) */}
                      {new Date(h.createdAt).toLocaleString(
                        i18n.language === 'en' ? 'en-GB' : 'vi-VN',
                      )}
                    </td>
                    <td style={{ padding: '0.25rem 0.75rem' }}>
                      {h.fromUserSub
                        ? (h.fromUserName ?? h.fromUserSub)
                        : t('assets.stock')}
                    </td>
                    <td style={{ padding: '0.25rem 0.75rem' }}>
                      {h.toUserSub
                        ? (h.toUserName ?? h.toUserSub)
                        : t('assets.stock')}
                    </td>
                    <td style={{ padding: '0.25rem 0.75rem' }}>
                      {h.actorName ?? h.actor}
                    </td>
                    <td style={{ padding: '0.25rem 0.75rem' }}>{h.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

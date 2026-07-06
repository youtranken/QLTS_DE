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

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/assets?page=${page}&pageSize=${PAGE_SIZE}`,
          { signal },
        );
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
    [page, t],
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
            if (saved) void load();
          }}
        />
      ) : (
        <>
          <button type="button" onClick={() => setForm(EMPTY_FORM)}>
            {t('assets.addAsset')}
          </button>
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
                  <tr key={a.id}>
                    <td style={cell}>{a.code}</td>
                    <td style={cell}>{a.type}</td>
                    <td style={cell}>
                      {a.assignedUserName ?? a.assignedUserSub ?? ''}
                    </td>
                    <td style={cell}>{a.floor}</td>
                    <td style={cell}>{t(`assets.status.${a.status}`)}</td>
                    <td style={cell}>{a.isPool ? '✓' : ''}</td>
                    <td style={cell}>
                      <button type="button" onClick={() => void openEdit(a.id)}>
                        {t('assets.edit')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.length === 0 && <p>{t('assets.empty')}</p>}
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
  const { t } = useTranslation();
  const [form, setForm] = useState(initial);
  const [userQuery, setUserQuery] = useState('');
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

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
      type: form.type,
      configuration: form.configuration || null,
      cost: form.cost === '' ? null : Number(form.cost),
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      floor: form.floor || null,
      note: form.note || null,
      serial: form.serial || null,
      brand: form.brand || null,
      model: form.model || null,
      assignedUserSub: form.assignedUserSub || null,
    };
    if (form.id) payload.version = form.version;
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
  }, [form, me.csrfToken, onDone, t]);

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
          <label style={field}>
            {t('assets.type')} *
            <input
              required
              maxLength={100}
              value={form.type}
              onChange={(e) => set('type')(e.target.value)}
            />
          </label>
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
          <label style={field}>
            {t('assets.endDate')}
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => set('endDate')(e.target.value)}
            />
          </label>
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
    </section>
  );
}

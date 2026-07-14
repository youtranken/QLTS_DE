import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface Me {
  sub: string;
  fullName?: string;
  email?: string;
  role: string;
  devMode?: boolean;
  csrfToken: string | null;
  permissions?: { canLongTerm: boolean; canRecurring: boolean };
}

interface SyncResult {
  total: number;
  created: number;
  updated: number;
  unchanged?: number;
  skipped?: number;
  groups: Array<{ id: string; name: string }>;
}

/** Khối đồng bộ danh bạ (story 1.3) — chỉ SA. */
export function DirectorySyncPanel({ csrfToken }: { csrfToken: string | null }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runSync = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/directory-sync', {
        method: 'POST',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
      });
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      const body = (await res.json()) as SyncResult & { message?: string };
      if (res.ok && Array.isArray(body.groups)) {
        setResult(body);
      } else {
        setError(body.message ?? t('sync.failed'));
      }
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [csrfToken, t]);

  return (
    <section className="section-gap">
      <h2>{t('sync.title')}</h2>
      <button type="button" className="primary" disabled={busy} onClick={() => void runSync()}>
        {busy ? t('sync.syncing') : t('sync.syncNow')}
      </button>
      {error && <p className="alert error">{error}</p>}
      {result && (
        <>
          <p>
            {t('sync.result', {
              total: result.total,
              created: result.created,
              updated: result.updated,
            })}
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            {t('sync.groupsSeen', {
              groups:
                result.groups.map((g) => g.name).join(', ') || t('sync.noGroups'),
            })}
          </p>
        </>
      )}
    </section>
  );
}

interface UserRow {
  sub: string;
  email: string | null;
  employeeCode: string | null;
  fullName: string | null;
  role: string;
  status: string;
  canLongTerm: boolean;
  canRecurring: boolean;
}

/** Màn Vai trò (story 1.5/1.6) — SA (đổi vai + quyền) và Admin (quyền). */
export function RolesPanel({
  csrfToken,
  mySub,
  viewerRole,
}: {
  csrfToken: string | null;
  mySub: string;
  viewerRole: string;
}) {
  const { t } = useTranslation();
  // Tìm: gõ tự do (searchInput) → search sau debounce 300ms (đồng bộ các trang khác).
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bổ nhiệm/miễn nhiệm admin là ĐỘC QUYỀN SSA (10.1) — admin chỉ vận hành, không cấp vai.
  const canChangeRole = viewerRole === 'sa';
  const PAGE_SIZE = 20;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/users?search=${encodeURIComponent(search)}&page=${page}&pageSize=${PAGE_SIZE}`,
          { signal },
        );
        if (res.status === 401) {
          window.location.href = '/';
          return;
        }
        const body = (await res.json()) as {
          items?: UserRow[];
          total?: number;
          message?: string;
        };
        if (res.ok && Array.isArray(body.items)) {
          setRows(body.items);
          setTotal(body.total ?? body.items.length);
        } else {
          setError(body.message ?? t('roles.loadFailed'));
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError(t('app.serverUnreachable'));
        }
      }
    },
    [search, page, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Debounce ô tìm → search; đổi từ khóa về trang 1 (tránh rơi ra ngoài phạm vi).
  useEffect(() => {
    const value = searchInput.trim();
    if (value === search) return;
    const timer = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  // Xóa dòng cuối trang khiến trang vượt phạm vi → kẹp về trang cuối hợp lệ.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const put = useCallback(
    async (url: string, payload: unknown, failMsg: string) => {
      setError(null);
      setBusy(true);
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          await load();
        } else {
          const body = (await res.json()) as { message?: string };
          setError(body.message ?? failMsg);
        }
      } catch {
        setError(t('app.serverUnreachable'));
      } finally {
        setBusy(false);
      }
    },
    [csrfToken, load, t],
  );

  const setRole = (sub: string, role: 'admin' | 'member') =>
    put(
      `/api/admin/users/${encodeURIComponent(sub)}/role`,
      { role },
      t('roles.roleChangeFailed'),
    );
  const setPermission = (
    sub: string,
    patch: { canLongTerm?: boolean; canRecurring?: boolean },
  ) =>
    put(
      `/api/admin/users/${encodeURIComponent(sub)}/permissions`,
      patch,
      t('roles.permissionChangeFailed'),
    );

  return (
    <section className="section-gap">
      <h2>{t('roles.title')}</h2>
      <div className="toolbar">
        <input
          className="search"
          aria-label={t('roles.searchPlaceholder')}
          placeholder={t('roles.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>
      {error && <p className="alert error">{error}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('roles.name')}</th>
              <th>{t('roles.employeeCode')}</th>
              <th>{t('roles.email')}</th>
              <th>{t('roles.role')}</th>
              <th>{t('roles.longTerm')}</th>
              <th>{t('roles.recurring')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.sub}>
                <td>{u.fullName ?? u.sub}</td>
                <td><span className="mono">{u.employeeCode}</span></td>
                <td>{u.email}</td>
                <td>
                  <span className={`badge ${u.role === 'member' ? 'muted' : 'ok'}`}>
                    {t(`roles.roleName.${u.role}`)}
                  </span>
                </td>
                <td>
                  {u.role === 'member' && (
                    <input
                      type="checkbox"
                      checked={u.canLongTerm}
                      disabled={busy}
                      onChange={(e) =>
                        void setPermission(u.sub, { canLongTerm: e.target.checked })
                      }
                    />
                  )}
                </td>
                <td>
                  {u.role === 'member' && (
                    <input
                      type="checkbox"
                      checked={u.canRecurring}
                      disabled={busy}
                      onChange={(e) =>
                        void setPermission(u.sub, { canRecurring: e.target.checked })
                      }
                    />
                  )}
                </td>
                <td className="table-actions">
                  {canChangeRole && u.sub !== mySub && u.role === 'member' && (
                    <button type="button" className="primary sm" disabled={busy} onClick={() => void setRole(u.sub, 'admin')}>
                      {t('roles.makeAdmin')}
                    </button>
                  )}
                  {canChangeRole && u.sub !== mySub && u.role === 'admin' && (
                    <button type="button" className="danger sm" disabled={busy} onClick={() => void setRole(u.sub, 'member')}>
                      {t('roles.removeAdmin')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > PAGE_SIZE && (
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
    </section>
  );
}

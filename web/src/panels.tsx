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
    <section style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem' }}>{t('sync.title')}</h2>
      <button type="button" disabled={busy} onClick={() => void runSync()}>
        {busy ? t('sync.syncing') : t('sync.syncNow')}
      </button>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {result && (
        <>
          <p>
            {t('sync.result', {
              total: result.total,
              created: result.created,
              updated: result.updated,
            })}
          </p>
          <p style={{ fontSize: '0.85rem', color: '#555' }}>
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
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canChangeRole = viewerRole === 'sa';

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/users?search=${encodeURIComponent(search)}&page=1&pageSize=20`,
          { signal },
        );
        if (res.status === 401) {
          window.location.href = '/';
          return;
        }
        const body = (await res.json()) as { items?: UserRow[]; message?: string };
        if (res.ok && Array.isArray(body.items)) {
          setRows(body.items);
        } else {
          setError(body.message ?? t('roles.loadFailed'));
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError(t('app.serverUnreachable'));
        }
      }
    },
    [search, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

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

  const cell: React.CSSProperties = { padding: '0.25rem 0.75rem' };

  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem' }}>{t('roles.title')}</h2>
      <input
        placeholder={t('roles.searchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ padding: '0.3rem 0.5rem', marginBottom: '0.5rem' }}
      />
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={cell}>{t('roles.name')}</th>
              <th style={cell}>{t('roles.employeeCode')}</th>
              <th style={cell}>{t('roles.email')}</th>
              <th style={cell}>{t('roles.role')}</th>
              <th style={cell}>{t('roles.longTerm')}</th>
              <th style={cell}>{t('roles.recurring')}</th>
              <th style={cell}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.sub}>
                <td style={cell}>{u.fullName ?? u.sub}</td>
                <td style={cell}>{u.employeeCode}</td>
                <td style={cell}>{u.email}</td>
                <td style={cell}>{u.role}</td>
                <td style={cell}>
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
                <td style={cell}>
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
                <td style={cell}>
                  {canChangeRole && u.sub !== mySub && u.role === 'member' && (
                    <button type="button" disabled={busy} onClick={() => void setRole(u.sub, 'admin')}>
                      {t('roles.makeAdmin')}
                    </button>
                  )}
                  {canChangeRole && u.sub !== mySub && u.role === 'admin' && (
                    <button type="button" disabled={busy} onClick={() => void setRole(u.sub, 'member')}>
                      {t('roles.removeAdmin')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';

/**
 * FE tối thiểu cho story 1.2 — khung UI song ngữ + sidebar theo vai là story 1.7.
 * CHỈ 401 mới nghĩa là chưa đăng nhập; lỗi khác (5xx/mất mạng) hiện thông báo
 * thay vì lừa user có phiên hợp lệ rằng họ đã bị đăng xuất.
 */
interface Me {
  sub: string;
  fullName?: string;
  email?: string;
  role: string;
  devMode?: boolean;
  csrfToken: string | null;
}

interface SyncResult {
  total: number;
  created: number;
  updated: number;
  groups: Array<{ id: string; name: string }>;
}

type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; me: Me }
  | { kind: 'error' };

const centerStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.75rem',
};

function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });
  const loginFailed = new URLSearchParams(window.location.search).get('login') === 'failed';

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (res) => {
        if (res.ok) {
          setAuth({ kind: 'authenticated', me: (await res.json()) as Me });
        } else if (res.status === 401) {
          setAuth({ kind: 'anonymous' });
        } else {
          setAuth({ kind: 'error' });
        }
      })
      .catch(() => setAuth({ kind: 'error' }));
  }, []);

  const logout = useCallback(async () => {
    if (auth.kind !== 'authenticated') return;
    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: auth.me.csrfToken ? { 'X-CSRF-Token': auth.me.csrfToken } : {},
      });
      if (res.ok) {
        const body = (await res.json()) as { logoutUrl?: string };
        window.location.href = body.logoutUrl ?? '/';
        return;
      }
    } catch {
      // rơi xuống reload — trang tải lại phản ánh trạng thái phiên THẬT
    }
    window.location.href = '/';
  }, [auth]);

  return (
    <main style={centerStyle}>
      <h1>QLTS — Hệ thống Quản Lý Tài Sản</h1>
      {auth.kind === 'loading' && <p>Đang kiểm tra phiên đăng nhập…</p>}
      {auth.kind === 'error' && (
        <>
          <p>Hệ thống đang gặp sự cố — vui lòng thử lại.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Thử lại
          </button>
        </>
      )}
      {auth.kind === 'anonymous' && (
        <>
          {loginFailed && (
            <p style={{ color: '#c0392b' }}>
              Đăng nhập không thành công — vui lòng thử lại.
            </p>
          )}
          <p>Đăng nhập bằng tài khoản PMH ID của công ty.</p>
          <a href="/api/auth/login">
            <button type="button">Đăng nhập</button>
          </a>
        </>
      )}
      {auth.kind === 'authenticated' && (
        <>
          <p>
            Xin chào <strong>{auth.me.fullName ?? auth.me.sub}</strong>
            {auth.me.email ? ` (${auth.me.email})` : ''}
          </p>
          <button type="button" onClick={() => void logout()}>
            Đăng xuất
          </button>
          {(auth.me.role === 'sa' || auth.me.devMode) && (
            <DirectorySyncPanel csrfToken={auth.me.csrfToken} />
          )}
          {(auth.me.role === 'sa' || auth.me.role === 'admin' || auth.me.devMode) && (
            <RolesPanel
              csrfToken={auth.me.csrfToken}
              mySub={auth.me.sub}
              viewerRole={auth.me.role}
            />
          )}
        </>
      )}
    </main>
  );
}

/** Khối tạm cho SA (story 1.3) — màn Quản trị đầy đủ thuộc story 1.5/1.7. */
function DirectorySyncPanel({ csrfToken }: { csrfToken: string | null }) {
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
        // Phiên hết hạn giữa chừng — reload để phản ánh trạng thái thật
        window.location.href = '/';
        return;
      }
      const body = (await res.json()) as SyncResult & { message?: string };
      if (res.ok && Array.isArray(body.groups)) {
        setResult(body);
      } else {
        setError(body.message ?? 'Đồng bộ thất bại — thử lại sau.');
      }
    } catch {
      setError('Không gọi được máy chủ — thử lại sau.');
    } finally {
      setBusy(false);
    }
  }, [csrfToken]);

  return (
    <section style={{ marginTop: '2rem', textAlign: 'center' }}>
      <h2 style={{ fontSize: '1rem' }}>Quản trị — Đồng bộ danh bạ PMH ID</h2>
      <button type="button" disabled={busy} onClick={() => void runSync()}>
        {busy ? 'Đang đồng bộ…' : 'Đồng bộ ngay'}
      </button>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {result && (
        <>
          <p>
            {result.total} user, {result.created} mới, {result.updated} cập nhật
          </p>
          <p style={{ fontSize: '0.85rem', color: '#555' }}>
            Group client đang thấy: {result.groups.map((g) => g.name).join(', ') || '(chưa được gán group nào)'}
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

/** Màn Vai trò tạm (story 1.5/1.6) — UI đầy đủ thuộc 1.7. Admin thấy toggle quyền; nút đổi vai chỉ SA. */
function RolesPanel({
  csrfToken,
  mySub,
  viewerRole,
}: {
  csrfToken: string | null;
  mySub: string;
  viewerRole: string;
}) {
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
          setError(body.message ?? 'Không tải được danh sách.');
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError('Không gọi được máy chủ.');
        }
      }
    },
    [search],
  );

  useEffect(() => {
    // Abort request cũ khi gõ tiếp — response chậm không ghi đè kết quả mới
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const setPermission = useCallback(
    async (sub: string, patch: { canLongTerm?: boolean; canRecurring?: boolean }) => {
      setError(null);
      setBusy(true);
      try {
        const res = await fetch(
          `/api/admin/users/${encodeURIComponent(sub)}/permissions`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
            },
            body: JSON.stringify(patch),
          },
        );
        if (res.ok) {
          await load();
        } else {
          const body = (await res.json()) as { message?: string };
          setError(body.message ?? 'Đổi quyền thất bại.');
        }
      } catch {
        setError('Không gọi được máy chủ.');
      } finally {
        setBusy(false);
      }
    },
    [csrfToken, load],
  );

  const setRole = useCallback(
    async (sub: string, role: 'admin' | 'member') => {
      setError(null);
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(sub)}/role`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          body: JSON.stringify({ role }),
        });
        if (res.ok) {
          await load();
        } else {
          const body = (await res.json()) as { message?: string };
          setError(body.message ?? 'Đổi vai thất bại.');
        }
      } catch {
        setError('Không gọi được máy chủ.');
      }
    },
    [csrfToken, load],
  );

  return (
    <section style={{ marginTop: '2rem', textAlign: 'center', maxWidth: 720 }}>
      <h2 style={{ fontSize: '1rem' }}>Quản trị — Vai trò</h2>
      <input
        placeholder="Tìm theo tên/email…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ padding: '0.3rem 0.5rem', marginBottom: '0.5rem' }}
      />
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      <table style={{ margin: '0 auto', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ padding: '0.25rem 0.75rem' }}>Tên</th>
            <th style={{ padding: '0.25rem 0.75rem' }}>Mã NV</th>
            <th style={{ padding: '0.25rem 0.75rem' }}>Email</th>
            <th style={{ padding: '0.25rem 0.75rem' }}>Vai</th>
            <th style={{ padding: '0.25rem 0.75rem' }}>Dài hạn</th>
            <th style={{ padding: '0.25rem 0.75rem' }}>Định kỳ</th>
            <th style={{ padding: '0.25rem 0.75rem' }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.sub}>
              <td style={{ padding: '0.25rem 0.75rem' }}>{u.fullName ?? u.sub}</td>
              <td style={{ padding: '0.25rem 0.75rem' }}>{u.employeeCode}</td>
              <td style={{ padding: '0.25rem 0.75rem' }}>{u.email}</td>
              <td style={{ padding: '0.25rem 0.75rem' }}>{u.role}</td>
              <td style={{ padding: '0.25rem 0.75rem' }}>
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
              <td style={{ padding: '0.25rem 0.75rem' }}>
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
              <td style={{ padding: '0.25rem 0.75rem' }}>
                {/* role 'sa' (từ env): không hiện nút; đổi vai chỉ SA (server cũng chặn) */}
                {canChangeRole && u.sub !== mySub && u.role === 'member' && (
                  <button type="button" onClick={() => void setRole(u.sub, 'admin')}>
                    Bổ nhiệm Admin
                  </button>
                )}
                {canChangeRole && u.sub !== mySub && u.role === 'admin' && (
                  <button type="button" onClick={() => void setRole(u.sub, 'member')}>
                    Miễn nhiệm
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default App;

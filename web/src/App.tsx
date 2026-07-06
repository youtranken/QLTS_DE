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
      const body = (await res.json()) as SyncResult & { message?: string };
      if (res.ok) {
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

export default App;

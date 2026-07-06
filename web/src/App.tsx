import { useCallback, useEffect, useState } from 'react';

/**
 * FE tối thiểu cho story 1.2 — khung UI song ngữ + sidebar theo vai là story 1.7.
 * Mọi 401 từ API → coi như chưa đăng nhập (guard server là nguồn chân lý).
 */
interface Me {
  sub: string;
  fullName?: string;
  email?: string;
  role: string;
  csrfToken: string | null;
}

type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; me: Me };

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

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (res) => {
        if (res.ok) {
          setAuth({ kind: 'authenticated', me: (await res.json()) as Me });
        } else {
          setAuth({ kind: 'anonymous' });
        }
      })
      .catch(() => setAuth({ kind: 'anonymous' }));
  }, []);

  const logout = useCallback(async () => {
    if (auth.kind !== 'authenticated') return;
    const res = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: auth.me.csrfToken ? { 'X-CSRF-Token': auth.me.csrfToken } : {},
    });
    const body = res.ok ? ((await res.json()) as { logoutUrl?: string }) : {};
    window.location.href = body.logoutUrl ?? '/';
  }, [auth]);

  return (
    <main style={centerStyle}>
      <h1>QLTS — Hệ thống Quản Lý Tài Sản</h1>
      {auth.kind === 'loading' && <p>Đang kiểm tra phiên đăng nhập…</p>}
      {auth.kind === 'anonymous' && (
        <>
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
        </>
      )}
    </main>
  );
}

export default App;

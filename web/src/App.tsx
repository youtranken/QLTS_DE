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
  csrfToken: string | null;
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
        </>
      )}
    </main>
  );
}

export default App;

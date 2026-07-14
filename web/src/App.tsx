import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Link, NavLink, useLocation } from 'react-router-dom';
import { CommandPalette } from './command-palette';
import type { Me } from './panels';
import { LoginScreen } from './login-screen';
import { LanguageSwitch, ThemeSwitch } from './switches';
import { navGroups } from './app-nav';
import { AppRoutes } from './app-routes';

type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; me: Me }
  | { kind: 'error' };

const BREAKPOINT = 900;

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(window.innerWidth < BREAKPOINT);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

// Chống vòng lặp auto-login: đã thử SSO im lặng 1 lần mà vẫn anonymous → dừng, hiện nút login.
const SSO_ATTEMPT_KEY = 'qlts_sso_attempt';
// Vừa logout local (phiên IdP còn sống) → CẤM auto-SSO vào lại; chờ user bấm login.
const LOGGED_OUT_KEY = 'qlts_logged_out';

function App() {
  const { t } = useTranslation();
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });
  const loginParam = new URLSearchParams(window.location.search).get('login');
  const loginFailed = loginParam === 'failed';
  // 10.2: tài khoản không thuộc group được phép → callback chặn, KHÔNG auto-SSO lại (tránh lặp)
  const loginForbidden = loginParam === 'forbidden';

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (res) => {
        if (res.ok) {
          sessionStorage.removeItem(SSO_ATTEMPT_KEY);
          sessionStorage.removeItem(LOGGED_OUT_KEY);
          setAuth({ kind: 'authenticated', me: (await res.json()) as Me });
        } else if (res.status === 401) {
          setAuth({ kind: 'anonymous' });
        } else {
          setAuth({ kind: 'error' });
        }
      })
      .catch(() => setAuth({ kind: 'error' }));
  }, []);

  // SSO liền mạch: chưa có phiên QLTS → thử /api/auth/login. Đã đăng nhập ở PMH ID (vào từ portal)
  // → IdP cấp code im lặng, vào thẳng. Chưa đăng nhập (vào link trực tiếp) → IdP hiện form login.
  // KHÔNG auto khi login=failed (vd access_denied) hoặc đã thử 1 lần (chống lặp).
  const willAutoLogin =
    auth.kind === 'anonymous' &&
    !loginFailed &&
    !loginForbidden &&
    !sessionStorage.getItem(SSO_ATTEMPT_KEY) &&
    !sessionStorage.getItem(LOGGED_OUT_KEY);
  useEffect(() => {
    if (willAutoLogin) {
      sessionStorage.setItem(SSO_ATTEMPT_KEY, '1');
      window.location.href = '/api/auth/login';
    }
  }, [willAutoLogin]);

  const logout = useCallback(async () => {
    if (auth.kind !== 'authenticated') return;
    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: auth.me.csrfToken ? { 'X-CSRF-Token': auth.me.csrfToken } : {},
      });
      if (res.ok) {
        // Local logout: phiên IdP còn sống → đánh dấu để KHÔNG auto-SSO vào lại
        sessionStorage.setItem(LOGGED_OUT_KEY, '1');
        window.location.href = '/';
        return;
      }
    } catch {
      // rơi xuống reload — trang tải lại phản ánh trạng thái phiên THẬT
    }
    window.location.href = '/';
  }, [auth]);

  // "Đăng nhập bằng tài khoản khác" (trang forbidden): xóa cờ chặn auto-SSO để sau khi PMH ID
  // kết thúc phiên SSO, app tự đưa về form login PMH ID; rồi chuyển tới endpoint end_session.
  const switchAccount = useCallback(() => {
    sessionStorage.removeItem(LOGGED_OUT_KEY);
    sessionStorage.removeItem(SSO_ATTEMPT_KEY);
    window.location.href = '/api/auth/switch-account';
  }, []);

  if (auth.kind === 'loading' || willAutoLogin) {
    return (
      <Center>
        <p>{t('app.checkingSession')}</p>
      </Center>
    );
  }
  if (auth.kind === 'error') {
    return (
      <Center>
        <p>{t('app.systemError')}</p>
        <button type="button" onClick={() => window.location.reload()}>
          {t('app.retry')}
        </button>
      </Center>
    );
  }
  if (auth.kind === 'anonymous') {
    return (
      <LoginScreen
        loginFailed={loginFailed}
        loginForbidden={loginForbidden}
        onSwitchAccount={switchAccount}
      />
    );
  }

  return (
    <BrowserRouter>
      <Shell me={auth.me} onLogout={() => void logout()} />
    </BrowserRouter>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <main className="center">{children}</main>;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  // 7.5: member KHÔNG sidebar (board full màn + nút Đặt máy ở topbar). Chỉ admin/sa có sidebar.
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  const showSidebar = isAdmin && (!narrow || menuOpen);

  return (
    <div className="app-shell">
      {narrow && menuOpen && isAdmin && (
        // Backdrop: bấm ngoài menu để đóng (nút hamburger bị nav che khi mở)
        <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} />
      )}
      {showSidebar && (
        <nav className={narrow ? 'sidebar is-drawer' : 'sidebar'}>
          <div className="brand">
            <span className="brand-mark">QL</span> QLTS
          </div>
          {(() => {
            const groups = navGroups(me.role);
            // "Prefix dài nhất thắng": sáng ĐÚNG một mục — mục con khớp cả path con
            // (vd /tai-san/import, /tai-san/:id vẫn sáng "Tài sản"), nhưng khi có mục
            // con cụ thể hơn (/tai-san/kiem-ke) thì mục đó thắng, cha không sáng kèm.
            const allTos = groups.flatMap((g) => g.items.map((i) => i.to));
            let activeTo: string | null = null;
            let bestLen = 0;
            for (const to of allTos) {
              const len =
                to === '/'
                  ? pathname === '/'
                    ? 1
                    : 0
                  : pathname === to || pathname.startsWith(`${to}/`)
                    ? to.length
                    : 0;
              if (len > bestLen) {
                bestLen = len;
                activeTo = to;
              }
            }
            return groups.map((group) => (
              <div key={group.label}>
                <div className="nav-label">{t(group.label)}</div>
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end
                    onClick={() => setMenuOpen(false)}
                    className={
                      item.to === activeTo ? 'nav-item active' : 'nav-item'
                    }
                  >
                    {t(item.key)}
                  </NavLink>
                ))}
              </div>
            ));
          })()}
        </nav>
      )}
      <div className="content">
        <header className="topbar">
          {narrow && isAdmin && (
            <button
              type="button"
              className="ghost"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ☰
            </button>
          )}
          <span className="spacer" />
          <Link to="/ho-so" className="hello linkbtn" title={t('profile.myProfile')}>
            {t('app.hello')} <strong>{me.fullName ?? me.sub}</strong>
          </Link>
          <ThemeSwitch />
          <LanguageSwitch />
          <button type="button" className="ghost sm" onClick={onLogout}>
            {t('app.logout')}
          </button>
        </header>
        <main className="page">
          <AppRoutes me={me} />
        </main>
      </div>
      <CommandPalette
        navItems={navGroups(me.role).flatMap((g) =>
          g.items.map((i) => ({ to: i.to, label: t(i.key) })),
        )}
        onLogout={onLogout}
      />
    </div>
  );
}

export default App;

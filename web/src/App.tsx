import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { CommandPalette } from '@/shell/command-palette';
import type { Me } from '@/lib/me';
import { LoginScreen } from '@/shell/login-screen';
import { navGroups } from '@/shell/app-nav';
import { SidebarNav } from '@/shell/app-sidebar-nav';
import { AppRoutes } from '@/shell/app-routes';
import { ChatbotPopup } from '@/chatbot/chatbot-popup';
import { ConfirmProvider } from '@/ui/confirm-provider';

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
        // Local logout: phiên IdP còn sống, nhưng màn login là ô email thủ công (không
        // auto-SSO) nên không lo tự đăng nhập lại — về '/' hiện màn login là đủ.
        window.location.href = '/';
        return;
      }
    } catch {
      // rơi xuống reload — trang tải lại phản ánh trạng thái phiên THẬT
    }
    window.location.href = '/';
  }, [auth]);

  // "Đăng nhập bằng tài khoản khác" (trang forbidden): PMH ID kết thúc phiên SSO rồi đưa về
  // app → màn login ô email; qua endpoint switch-account để gọi end_session của IdP.
  const switchAccount = useCallback(() => {
    window.location.href = '/api/auth/switch-account';
  }, []);

  if (auth.kind === 'loading') {
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
      <ConfirmProvider>
        <Shell me={auth.me} onLogout={() => void logout()} />
      </ConfirmProvider>
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
  // Thu gọn sidebar thành rail (chỉ desktop); mobile thì nút nổi mở/đóng drawer.
  const [collapsed, setCollapsed] = useState(false);
  // Bỏ header: MỌI vai (member/admin/sa) đều có sidebar; hồ sơ/ngôn ngữ/đăng xuất nằm ở đáy sidebar.
  const showSidebar = !narrow || menuOpen;
  const toggleNav = () =>
    narrow ? setMenuOpen((v) => !v) : setCollapsed((v) => !v);

  return (
    <div className={`app-shell${collapsed && !narrow ? ' collapsed' : ''}`}>
      {narrow && menuOpen && (
        // Backdrop: bấm ngoài menu để đóng (nút hamburger bị nav che khi mở)
        <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} />
      )}
      {narrow && !menuOpen && (
        // Không còn header: nút nổi mở drawer trên mobile (desktop luôn hiện sidebar).
        <button
          type="button"
          className="nav-fab"
          aria-label={t('app.toggleNav', 'Mở menu')}
          onClick={() => setMenuOpen(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      )}
      {showSidebar && (
        <nav className={narrow ? 'sidebar is-drawer' : 'sidebar'}>
          <SidebarNav
            me={me}
            role={me.role}
            pathname={pathname}
            collapsed={collapsed && !narrow}
            onToggleCollapse={toggleNav}
            onNavigate={() => setMenuOpen(false)}
            onLogout={onLogout}
          />
        </nav>
      )}
      <div className="content">
        {/* Mọi trang dùng bề ngang rộng (gần full) cho đồng nhất — đỡ trống 2 bên. */}
        <main className="page page-wide">
          <AppRoutes me={me} />
        </main>
      </div>
      <CommandPalette
        navItems={navGroups(me.role).flatMap((g) =>
          g.items.flatMap((i) =>
            i.children
              ? i.children.map((c) => ({ to: c.to, label: t(c.key) }))
              : i.to
                ? [{ to: i.to, label: t(i.key) }]
                : [],
          ),
        )}
        onLogout={onLogout}
      />
      <ChatbotPopup me={me} />
    </div>
  );
}

export default App;

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';
import { AssetDetailPage, AssetsPage } from './assets';
import { InventoryPage } from './inventory';
import { savedLanguage, setLanguage } from './i18n';
import { DirectorySyncPanel, RolesPanel } from './panels';
import type { Me } from './panels';

type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; me: Me }
  | { kind: 'error' };

const BREAKPOINT = 768;

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
  const loginFailed =
    new URLSearchParams(window.location.search).get('login') === 'failed';

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
      <Center>
        <h1>{t('app.title')}</h1>
        <LanguageSwitch />
        {loginFailed && (
          <p style={{ color: '#c0392b' }}>{t('app.loginFailed')}</p>
        )}
        <p>{t('app.loginPrompt')}</p>
        <a href="/api/auth/login">
          <button type="button">{t('app.login')}</button>
        </a>
      </Center>
    );
  }

  return (
    <BrowserRouter>
      <Shell me={auth.me} onLogout={() => void logout()} />
    </BrowserRouter>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
      }}
    >
      {children}
    </main>
  );
}

function LanguageSwitch() {
  const [lang, setLang] = useState(savedLanguage());
  const toggle = () => {
    const next = lang === 'vi' ? 'en' : 'vi';
    setLanguage(next);
    setLang(next);
  };
  return (
    <button type="button" onClick={toggle} style={{ fontSize: '0.85rem' }}>
      {lang === 'vi' ? 'EN' : 'VI'}
    </button>
  );
}

/** Sidebar theo vai (NFR-2): [Xử lý mượn] và [Quản lý tài sản] TÁCH BIỆT — không gộp. */
function navItems(role: string): Array<{ to: string; key: string }> {
  const items = [{ to: '/', key: 'nav.booking' }];
  if (role === 'admin' || role === 'sa') {
    items.push(
      { to: '/xu-ly-muon', key: 'nav.lending' },
      { to: '/tai-san', key: 'nav.assets' },
      { to: '/bao-cao', key: 'nav.reports' },
    );
  }
  if (role === 'sa' || role === 'admin') {
    // Quản trị: SA đầy đủ; Admin chỉ phần quyền per-user (server enforce từng API)
    items.push({ to: '/quan-tri', key: 'nav.admin' });
  }
  return items;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t } = useTranslation();
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const showSidebar = !narrow || menuOpen;

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {narrow && menuOpen && (
        // Backdrop: bấm ngoài menu để đóng (nút hamburger bị nav che khi mở)
        <div
          onClick={() => setMenuOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.3)',
            zIndex: 9,
          }}
        />
      )}
      {showSidebar && (
        <nav
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: '1px solid #ddd',
            padding: '1rem',
            background: '#fff',
            ...(narrow
              ? { position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 10 }
              : {}),
          }}
        >
          <h2 style={{ fontSize: '1rem', marginBottom: '1rem' }}>QLTS</h2>
          {navItems(me.role).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setMenuOpen(false)}
              style={({ isActive }) => ({
                display: 'block',
                padding: '0.4rem 0.5rem',
                textDecoration: 'none',
                color: isActive ? '#0b5ed7' : '#1a1a2e',
                fontWeight: isActive ? 700 : 400,
              })}
            >
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.5rem 1rem',
            borderBottom: '1px solid #ddd',
          }}
        >
          {narrow && (
            <button type="button" onClick={() => setMenuOpen((v) => !v)}>
              ☰ {t('nav.menu')}
            </button>
          )}
          <span style={{ flex: 1 }}>
            {t('app.hello')} <strong>{me.fullName ?? me.sub}</strong>
          </span>
          <LanguageSwitch />
          <button type="button" onClick={onLogout}>
            {t('app.logout')}
          </button>
        </header>
        <main style={{ padding: '1rem' }}>
          <Routes>
            <Route path="/" element={<Placeholder titleKey="nav.booking" />} />
            <Route
              path="/xu-ly-muon"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <Placeholder titleKey="nav.lending" />
                </RequireRole>
              }
            />
            <Route
              path="/tai-san"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <AssetsPage me={me} />
                </RequireRole>
              }
            />
            <Route
              path="/tai-san/kiem-ke"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <InventoryPage me={me} />
                </RequireRole>
              }
            />
            <Route
              path="/tai-san/:id"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <AssetDetailPage me={me} />
                </RequireRole>
              }
            />
            <Route
              path="/bao-cao"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <Placeholder titleKey="nav.reports" />
                </RequireRole>
              }
            />
            <Route
              path="/quan-tri"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <AdminPage me={me} />
                </RequireRole>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/** FE guard (NFR-7): ẩn menu KHÔNG phải là phân quyền — server luôn 403 độc lập. */
function RequireRole({
  me,
  roles,
  children,
}: {
  me: Me;
  roles: string[];
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (!roles.includes(me.role) && !me.devMode) {
    return <p>{t('app.noPermission')}</p>;
  }
  return <>{children}</>;
}

function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <>
      <h1 style={{ fontSize: '1.2rem' }}>{t(titleKey)}</h1>
      <p>{t('app.underConstruction')}</p>
    </>
  );
}

function AdminPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  return (
    <>
      <h1 style={{ fontSize: '1.2rem' }}>{t('nav.admin')}</h1>
      {(me.role === 'sa' || me.devMode) && (
        <DirectorySyncPanel csrfToken={me.csrfToken} />
      )}
      <RolesPanel csrfToken={me.csrfToken} mySub={me.sub} viewerRole={me.role} />
    </>
  );
}

export default App;

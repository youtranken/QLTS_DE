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
import { BookingPage, InUseNowPanel } from './booking';
import { MachineCalendarPage } from './machine-calendar';
import { ApprovalQueuePage } from './approval-queue';
import { AdminDashboard } from './admin-dashboard';
import { NotificationsFailedPage } from './notifications-failed';
import { OffboardingQueuePage } from './offboarding-queue';
import { ReportsPage } from './reports';
import { ImportPage } from './import-page';
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
        <div className="brand" style={{ fontSize: '1.4rem', padding: 0 }}>
          <span className="brand-mark">QL</span> {t('app.title')}
        </div>
        {loginFailed && (
          <p className="alert error" style={{ margin: 0 }}>
            {t('app.loginFailed')}
          </p>
        )}
        <p className="muted">{t('app.loginPrompt')}</p>
        <a href="/api/auth/login">
          <button type="button" className="primary">
            {t('app.login')}
          </button>
        </a>
        <LanguageSwitch />
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
  return <main className="center">{children}</main>;
}

function LanguageSwitch() {
  const [lang, setLang] = useState(savedLanguage());
  const toggle = () => {
    const next = lang === 'vi' ? 'en' : 'vi';
    setLanguage(next);
    setLang(next);
  };
  return (
    <button type="button" className="ghost sm" onClick={toggle}>
      {lang === 'vi' ? 'EN' : 'VI'}
    </button>
  );
}

interface NavGroup {
  label: string;
  items: Array<{ to: string; key: string }>;
}

/**
 * Sidebar theo vai, NHÓM theo domain (NFR-2): domain "Mượn tài sản" tách hẳn khỏi
 * "Quản lý tài sản" cho đỡ rối. "Máy đang mượn" là mục riêng (tách khỏi trang đặt máy).
 */
function navGroups(role: string): NavGroup[] {
  const isAdmin = role === 'admin' || role === 'sa';
  const groups: NavGroup[] = [];

  // Domain Mượn tài sản — landing theo vai (3.12): admin → dashboard, member → đặt máy
  const borrow = [{ to: '/', key: isAdmin ? 'nav.dashboard' : 'nav.booking' }];
  if (isAdmin) borrow.push({ to: '/xu-ly-muon', key: 'nav.lending' });
  borrow.push({ to: '/may-dang-muon', key: 'nav.inUse' });
  groups.push({ label: 'nav.groupBorrow', items: borrow });

  // Domain Quản lý tài sản (admin/sa)
  if (isAdmin) {
    groups.push({
      label: 'nav.groupAssets',
      items: [
        { to: '/tai-san', key: 'nav.assets' },
        { to: '/tai-san/kiem-ke', key: 'nav.inventory' },
        { to: '/bao-cao', key: 'nav.reports' },
      ],
    });
    // Hệ thống — Quản trị (SA đầy đủ; Admin chỉ phần quyền per-user, server enforce)
    groups.push({
      label: 'nav.groupSystem',
      items: [{ to: '/quan-tri', key: 'nav.admin' }],
    });
  }
  return groups;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t } = useTranslation();
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const showSidebar = !narrow || menuOpen;

  return (
    <div className="app-shell">
      {narrow && menuOpen && (
        // Backdrop: bấm ngoài menu để đóng (nút hamburger bị nav che khi mở)
        <div
          onClick={() => setMenuOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(27,34,49,0.4)',
            zIndex: 9,
          }}
        />
      )}
      {showSidebar && (
        <nav
          className="sidebar"
          style={
            narrow
              ? { position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 10 }
              : undefined
          }
        >
          <div className="brand">
            <span className="brand-mark">QL</span> QLTS
          </div>
          {navGroups(me.role).map((group) => (
            <div key={group.label}>
              <div className="nav-label">{t(group.label)}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    isActive ? 'nav-item active' : 'nav-item'
                  }
                >
                  {t(item.key)}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      )}
      <div className="content">
        <header className="topbar">
          {narrow && (
            <button
              type="button"
              className="ghost"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ☰
            </button>
          )}
          <span className="spacer" />
          <span className="hello">
            {t('app.hello')} <strong>{me.fullName ?? me.sub}</strong>
          </span>
          <LanguageSwitch />
          <button type="button" className="ghost sm" onClick={onLogout}>
            {t('app.logout')}
          </button>
        </header>
        <main className="page">
          <Routes>
            {/* Landing theo vai (3.12, NFR-2): admin/sa → dashboard tác vụ; member → đặt máy. */}
            <Route
              path="/"
              element={
                me.role === 'admin' || me.role === 'sa' ? (
                  <AdminDashboard />
                ) : (
                  <BookingPage me={me} />
                )
              }
            />
            <Route path="/lich-may/:id" element={<MachineCalendarPage />} />
            {/* Máy đang mượn — mục sidebar riêng (tách khỏi trang đặt máy). Member + admin. */}
            <Route
              path="/may-dang-muon"
              element={
                <section>
                  <InUseNowPanel standalone />
                </section>
              }
            />
            <Route
              path="/xu-ly-muon"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <ApprovalQueuePage me={me} />
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
              path="/tai-san/import"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <ImportPage me={me} />
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
                  <ReportsPage />
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
            <Route
              path="/thong-bao-loi"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <NotificationsFailedPage me={me} />
                </RequireRole>
              }
            />
            <Route
              path="/canh-bao-nghi-viec"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <OffboardingQueuePage />
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

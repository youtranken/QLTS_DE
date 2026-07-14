import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { BorrowBoardPage } from './borrow-board';
import { CommandPalette } from './command-palette';
import { NotFound } from './load-state';
import { ChunkErrorBoundary } from './chunk-error-boundary';
import { savedLanguage, setLanguage } from './i18n';
import { currentTheme, toggleTheme } from './theme';
import { DirectorySyncPanel, RolesPanel } from './panels';
import type { Me } from './panels';
import { SaLoginForm } from './sa-login-form';

// Code-splitting theo route (perf): mỗi trang thành 1 chunk tải khi điều hướng tới, giảm
// bundle khởi động. Landing (BorrowBoard) + panel nhỏ giữ eager để trang đầu không chớp fallback.
const AssetsPage = lazy(() =>
  import('./assets').then((m) => ({ default: m.AssetsPage })),
);
const AssetDetailPage = lazy(() =>
  import('./assets').then((m) => ({ default: m.AssetDetailPage })),
);
const SoftwareGroupsPage = lazy(() =>
  import('./software-groups-page').then((m) => ({
    default: m.SoftwareGroupsPage,
  })),
);
const SoftwareLicensePage = lazy(() =>
  import('./assets').then((m) => ({ default: m.SoftwareLicensePage })),
);
const MachineCalendarPage = lazy(() =>
  import('./machine-calendar').then((m) => ({ default: m.MachineCalendarPage })),
);
const ProfilePage = lazy(() =>
  import('./profile').then((m) => ({ default: m.ProfilePage })),
);
const CalendarOverviewPage = lazy(() =>
  import('./calendar-overview').then((m) => ({
    default: m.CalendarOverviewPage,
  })),
);
const ApprovalQueuePage = lazy(() =>
  import('./approval-queue').then((m) => ({ default: m.ApprovalQueuePage })),
);
const NotificationsFailedPage = lazy(() =>
  import('./notifications-failed').then((m) => ({
    default: m.NotificationsFailedPage,
  })),
);
const OffboardingQueuePage = lazy(() =>
  import('./offboarding-queue').then((m) => ({
    default: m.OffboardingQueuePage,
  })),
);
const ReportsPage = lazy(() =>
  import('./reports').then((m) => ({ default: m.ReportsPage })),
);
const AuditLogPage = lazy(() =>
  import('./audit-log').then((m) => ({ default: m.AuditLogPage })),
);
const ConfigPage = lazy(() =>
  import('./config-page').then((m) => ({ default: m.ConfigPage })),
);
const CatalogPage = lazy(() =>
  import('./catalog-page').then((m) => ({ default: m.CatalogPage })),
);
const PoolPage = lazy(() =>
  import('./pool-page').then((m) => ({ default: m.PoolPage })),
);
const ImportPage = lazy(() =>
  import('./import-page').then((m) => ({ default: m.ImportPage })),
);
const InventoryPage = lazy(() =>
  import('./inventory').then((m) => ({ default: m.InventoryPage })),
);

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
      <div className="auth">
        <aside className="auth-hero">
          <div className="auth-logo">
            <span className="brand-mark">QL</span>
            <div>
              <div className="auth-name">{t('app.title')}</div>
              <div className="auth-sub">{t('app.loginSub')}</div>
            </div>
          </div>
          <p className="auth-slogan">{t('app.loginSlogan')}</p>
          <ul className="auth-perks">
            <li className="auth-perk">✓ {t('app.loginPerk1')}</li>
            <li className="auth-perk">✓ {t('app.loginPerk2')}</li>
          </ul>
        </aside>
        <div className="auth-panel">
          <div className="auth-card">
            {loginFailed && (
              <p className="alert error" style={{ margin: 0 }}>
                {t('app.loginFailed')}
              </p>
            )}
            {loginForbidden ? (
              // Bị chặn (bị xóa/gỡ group): bấm "Đăng nhập" thường sẽ silent re-auth ra đúng
              // access_denied → lặp. Lối thoát DUY NHẤT là đổi tài khoản (kết thúc phiên SSO).
              <>
                <p className="alert error" style={{ margin: 0 }}>
                  {t('app.loginForbidden')}
                </p>
                <button type="button" className="primary" onClick={switchAccount}>
                  {t('app.loginOtherAccount')}
                </button>
              </>
            ) : (
              <>
                <h1>{t('app.loginHeading')}</h1>
                <p className="muted" style={{ margin: 0 }}>
                  {t('app.loginPrompt')}
                </p>
                <a href="/api/auth/login">
                  <button type="button" className="primary" style={{ width: '100%' }}>
                    {t('app.login')}
                  </button>
                </a>
              </>
            )}
            <SaLoginForm />
            <div className="auth-switches">
              <ThemeSwitch />
              <LanguageSwitch />
            </div>
          </div>
        </div>
      </div>
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

/** Fallback khi chunk trang lazy đang tải — skeleton nhẹ để không chớp trắng. */
function PageFallback() {
  return (
    <div className="page-fallback" aria-busy="true" aria-live="polite">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-block" />
    </div>
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
    <button type="button" className="ghost sm" onClick={toggle}>
      {lang === 'vi' ? 'EN' : 'VI'}
    </button>
  );
}

function ThemeSwitch() {
  const [theme, setThemeState] = useState(currentTheme());
  return (
    <button
      type="button"
      className="ghost sm"
      onClick={() => setThemeState(toggleTheme())}
      title={theme === 'dark' ? 'Chế độ sáng' : 'Chế độ tối'}
      aria-label={theme === 'dark' ? 'Chế độ sáng' : 'Chế độ tối'}
    >
      {theme === 'dark' ? '☀' : '🌙'}
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

  // Domain Mượn tài sản — landing theo vai (3.12): admin → dashboard, member → đặt máy.
  // "Máy đang mượn" đã gộp vào Trang chủ (bảng board giàu hơn) → không còn mục riêng.
  const borrow = [{ to: '/', key: isAdmin ? 'nav.dashboard' : 'nav.booking' }];
  if (isAdmin) borrow.push({ to: '/xu-ly-muon', key: 'nav.lending' });
  if (isAdmin) borrow.push({ to: '/lich-may', key: 'nav.calendar' });
  groups.push({ label: 'nav.groupBorrow', items: borrow });

  // Domain Quản lý tài sản (admin/sa)
  if (isAdmin) {
    groups.push({
      label: 'nav.groupAssets',
      items: [
        { to: '/tai-san', key: 'nav.assets' },
        { to: '/phan-mem', key: 'nav.software' },
        { to: '/pool-may-muon', key: 'nav.pool' },
        { to: '/tai-san/kiem-ke', key: 'nav.inventory' },
        { to: '/tai-san/thanh-ly', key: 'nav.disposed' },
        { to: '/bao-cao', key: 'nav.reports' },
      ],
    });
    // Hệ thống — Quản trị. Delegation 10.1: Admin (SSO) lo hằng ngày, có cả Audit log +
    // Cấu hình + bổ nhiệm admin. SA local chỉ là break-glass. Server @Roles enforce độc lập.
    groups.push({
      label: 'nav.groupSystem',
      items: [
        { to: '/quan-tri', key: 'nav.admin' },
        { to: '/quan-tri/danh-muc', key: 'nav.catalog' },
        ...(isAdmin
          ? [
              { to: '/quan-tri/audit', key: 'nav.audit' },
              { to: '/quan-tri/cau-hinh', key: 'nav.config' },
            ]
          : []),
      ],
    });
  }
  return groups;
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
          <ChunkErrorBoundary
            fallback={
              <div
                className="load-error"
                style={{ padding: '2rem 0', textAlign: 'center' }}
              >
                <p style={{ color: 'var(--danger)', marginBottom: '.75rem' }}>
                  {t('app.chunkError')}
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => window.location.reload()}
                >
                  {t('app.reload')}
                </button>
              </div>
            }
          >
          <Suspense fallback={<PageFallback />}>
          <Routes>
            {/* Landing 7.5: borrow board cho MỌI vai (thay dashboard/đặt-máy cũ ở '/'). */}
            <Route path="/" element={<BorrowBoardPage me={me} />} />
            <Route path="/lich-may/:id" element={<MachineCalendarPage />} />
            <Route path="/lich-may" element={<CalendarOverviewPage />} />
            <Route path="/ho-so" element={<ProfilePage me={me} />} />
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
              path="/phan-mem"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <SoftwareGroupsPage me={me} />
                </RequireRole>
              }
            />
            <Route
              path="/phan-mem/license/:name"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <SoftwareLicensePage me={me} />
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
              path="/tai-san/thanh-ly"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <AssetsPage me={me} disposedOnly />
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
              path="/pool-may-muon"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <PoolPage me={me} />
                </RequireRole>
              }
            />
            <Route
              path="/quan-tri/danh-muc"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <CatalogPage me={me} />
                </RequireRole>
              }
            />
            <Route
              path="/quan-tri/audit"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <AuditLogPage />
                </RequireRole>
              }
            />
            <Route
              path="/quan-tri/cau-hinh"
              element={
                <RequireRole me={me} roles={['admin', 'sa']}>
                  <ConfigPage me={me} />
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
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          </ChunkErrorBoundary>
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
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  return (
    <>
      <h1 style={{ fontSize: '1.2rem' }}>{t('nav.admin')}</h1>
      {(isAdmin || me.devMode) && (
        <DirectorySyncPanel csrfToken={me.csrfToken} />
      )}
      <RolesPanel csrfToken={me.csrfToken} mySub={me.sub} viewerRole={me.role} />
    </>
  );
}

export default App;

import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { NotFound } from './load-state';
import { ChunkErrorBoundary } from './chunk-error-boundary';
import { DirectorySyncPanel, RolesPanel } from './panels';
import type { Me } from './panels';

// Code-splitting theo route (perf): mỗi trang thành 1 chunk tải khi điều hướng tới, giảm
// bundle khởi động. Landing '/' = Lịch máy (CalendarOverviewPage) cũng lazy như các trang khác.
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

/** Fallback khi chunk trang lazy đang tải — skeleton nhẹ để không chớp trắng. */
function PageFallback() {
  return (
    <div className="page-fallback" aria-busy="true" aria-live="polite">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-block" />
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

// Path tiếng Việt cũ → tiếng Anh mới (specific trước prefix). Giữ bookmark/link cũ không vỡ.
const LEGACY_ROUTES: Array<[string, string]> = [
  ['/tai-san/thanh-ly', '/assets/disposed'],
  ['/tai-san/import', '/assets/import'],
  ['/tai-san', '/assets'],
  ['/phan-mem/thanh-ly', '/software/disposed'],
  ['/phan-mem/license', '/software/license'],
  ['/phan-mem', '/software'],
  ['/quan-tri/danh-muc', '/admin/catalog'],
  ['/quan-tri/cau-hinh', '/admin/config'],
  ['/quan-tri/audit', '/admin/audit'],
  ['/quan-tri', '/admin'],
  ['/xu-ly-muon', '/approvals'],
  ['/pool-may-muon', '/pool'],
  ['/ho-so', '/profile'],
  ['/thong-bao-loi', '/notifications'],
  ['/canh-bao-nghi-viec', '/offboarding'],
];

/** Bắt path tiếng Việt cũ → redirect sang path tiếng Anh mới (giữ phần đuôi + query); còn lại 404. */
function LegacyRedirect() {
  const { pathname, search } = useLocation();
  for (const [from, to] of LEGACY_ROUTES) {
    if (pathname === from || pathname.startsWith(`${from}/`)) {
      return <Navigate to={pathname.replace(from, to) + search} replace />;
    }
  }
  return <NotFound />;
}

/** Bảng định tuyến toàn app — bọc ChunkErrorBoundary + Suspense cho lazy chunk. */
export function AppRoutes({ me }: { me: Me }) {
  const { t } = useTranslation();
  const admin = (children: React.ReactNode) => (
    <RequireRole me={me} roles={['admin', 'sa']}>
      {children}
    </RequireRole>
  );
  return (
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
          {/* Landing: Lịch máy cho MỌI vai (member/admin/sa). Path tiếng Anh cho gọn/chuyên
              nghiệp; path tiếng Việt cũ tự redirect qua LegacyRedirect ('*'). */}
          <Route path="/" element={<CalendarOverviewPage me={me} />} />
          <Route path="/profile" element={<ProfilePage me={me} />} />
          <Route path="/approvals" element={admin(<ApprovalQueuePage me={me} />)} />
          <Route path="/assets" element={admin(<AssetsPage me={me} />)} />
          <Route path="/software" element={admin(<SoftwareGroupsPage me={me} />)} />
          <Route
            path="/software/license/:name"
            element={admin(<SoftwareLicensePage me={me} />)}
          />
          <Route
            path="/software/disposed"
            element={admin(<AssetsPage me={me} disposedOnly softwareOnly />)}
          />
          <Route path="/assets/import" element={admin(<ImportPage me={me} />)} />
          <Route
            path="/assets/disposed"
            element={admin(<AssetsPage me={me} disposedOnly />)}
          />
          <Route path="/assets/:id" element={admin(<AssetDetailPage me={me} />)} />
          <Route path="/admin" element={admin(<AdminPage me={me} />)} />
          <Route path="/pool" element={admin(<PoolPage me={me} />)} />
          <Route
            path="/admin/catalog"
            element={admin(<CatalogPage me={me} />)}
          />
          <Route path="/admin/audit" element={admin(<AuditLogPage />)} />
          <Route
            path="/admin/config"
            element={admin(<ConfigPage me={me} />)}
          />
          <Route
            path="/notifications"
            element={admin(<NotificationsFailedPage me={me} />)}
          />
          <Route
            path="/offboarding"
            element={admin(<OffboardingQueuePage />)}
          />
          <Route path="*" element={<LegacyRedirect />} />
        </Routes>
      </Suspense>
    </ChunkErrorBoundary>
  );
}

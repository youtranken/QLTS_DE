import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router-dom';
import { BorrowBoardPage } from './borrow-board';
import { NotFound } from './load-state';
import { ChunkErrorBoundary } from './chunk-error-boundary';
import { DirectorySyncPanel, RolesPanel } from './panels';
import type { Me } from './panels';

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
          {/* Landing 7.5: borrow board cho MỌI vai (thay dashboard/đặt-máy cũ ở '/'). */}
          <Route path="/" element={<BorrowBoardPage me={me} />} />
          <Route path="/lich-may/:id" element={<MachineCalendarPage />} />
          <Route path="/lich-may" element={<CalendarOverviewPage me={me} />} />
          <Route path="/ho-so" element={<ProfilePage me={me} />} />
          <Route path="/xu-ly-muon" element={admin(<ApprovalQueuePage me={me} />)} />
          <Route path="/tai-san" element={admin(<AssetsPage me={me} />)} />
          <Route path="/phan-mem" element={admin(<SoftwareGroupsPage me={me} />)} />
          <Route
            path="/phan-mem/license/:name"
            element={admin(<SoftwareLicensePage me={me} />)}
          />
          <Route
            path="/phan-mem/thanh-ly"
            element={admin(<AssetsPage me={me} disposedOnly softwareOnly />)}
          />
          <Route path="/tai-san/import" element={admin(<ImportPage me={me} />)} />
          <Route
            path="/tai-san/kiem-ke"
            element={admin(<InventoryPage me={me} />)}
          />
          <Route
            path="/tai-san/thanh-ly"
            element={admin(<AssetsPage me={me} disposedOnly />)}
          />
          <Route path="/tai-san/:id" element={admin(<AssetDetailPage me={me} />)} />
          <Route path="/bao-cao" element={admin(<ReportsPage />)} />
          <Route path="/quan-tri" element={admin(<AdminPage me={me} />)} />
          <Route path="/pool-may-muon" element={admin(<PoolPage me={me} />)} />
          <Route
            path="/quan-tri/danh-muc"
            element={admin(<CatalogPage me={me} />)}
          />
          <Route path="/quan-tri/audit" element={admin(<AuditLogPage />)} />
          <Route
            path="/quan-tri/cau-hinh"
            element={admin(<ConfigPage me={me} />)}
          />
          <Route
            path="/thong-bao-loi"
            element={admin(<NotificationsFailedPage me={me} />)}
          />
          <Route
            path="/canh-bao-nghi-viec"
            element={admin(<OffboardingQueuePage />)}
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ChunkErrorBoundary>
  );
}

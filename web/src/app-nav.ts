export interface NavGroup {
  label: string;
  items: Array<{ to: string; key: string }>;
}

/**
 * Sidebar theo vai, NHÓM theo domain (NFR-2): domain "Mượn tài sản" tách hẳn khỏi
 * "Quản lý tài sản" cho đỡ rối. Dùng cho cả sidebar lẫn command palette (⌘K).
 */
export function navGroups(role: string): NavGroup[] {
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

export interface NavItem {
  to?: string; // link lá (bỏ trống khi là mục cha có children)
  key: string; // khóa i18n cho nhãn
  children?: Array<{ to: string; key: string }>; // dropdown gấp gọn
}

export interface NavGroup {
  label: string;
  items: NavItem[];
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
        {
          key: 'nav.disposed',
          children: [
            { to: '/tai-san/thanh-ly', key: 'nav.disposedKindDevice' },
            { to: '/phan-mem/thanh-ly', key: 'nav.disposedKindSoftware' },
          ],
        },
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

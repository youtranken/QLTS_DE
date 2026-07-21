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

  // Domain Mượn tài sản — Trang chủ '/' = Lịch máy cho MỌI vai (đặt máy + bảng đang mượn
  // đã nằm sẵn trong Lịch máy). Borrow board/dashboard cũ đã bỏ.
  const borrow = [{ to: '/', key: 'nav.calendar' }];
  if (isAdmin) borrow.push({ to: '/approvals', key: 'nav.lending' });
  groups.push({ label: 'nav.groupBorrow', items: borrow });

  // Domain Quản lý tài sản (admin/sa)
  if (isAdmin) {
    groups.push({
      label: 'nav.groupAssets',
      items: [
        { to: '/assets', key: 'nav.assets' },
        { to: '/software', key: 'nav.software' },
        { to: '/pool', key: 'nav.pool' },
        {
          key: 'nav.disposed',
          children: [
            { to: '/assets/disposed', key: 'nav.disposedKindDevice' },
            { to: '/software/disposed', key: 'nav.disposedKindSoftware' },
          ],
        },
      ],
    });
    // Hệ thống — Quản trị. Delegation 10.1: Admin (SSO) lo hằng ngày, có cả Audit log +
    // Cấu hình + bổ nhiệm admin. SA local chỉ là break-glass. Server @Roles enforce độc lập.
    groups.push({
      label: 'nav.groupSystem',
      items: [
        { to: '/admin', key: 'nav.admin' },
        { to: '/admin/catalog', key: 'nav.catalog' },
        ...(isAdmin
          ? [
              { to: '/admin/audit', key: 'nav.audit' },
              { to: '/admin/config', key: 'nav.config' },
            ]
          : []),
      ],
    });
  }
  return groups;
}

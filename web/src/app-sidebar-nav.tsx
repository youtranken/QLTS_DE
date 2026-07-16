import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { navGroups, type NavItem } from './app-nav';
import { NavIcon } from './nav-icon';
import { ThemeSwitch } from './switches';
import { useNavCounts } from './use-nav-counts';
import type { Me } from './panels';

// Lazy: giữ Hồ sơ (profile) ở chunk riêng — sidebar luôn tải nên không nhồi profile vào chunk chính.
const ProfileDialog = lazy(() =>
  import('./profile-dialog').then((m) => ({ default: m.ProfileDialog })),
);

/** Mọi đích điều hướng (kể cả mục con của dropdown) — để tính "prefix dài nhất thắng". */
function allTargets(items: NavItem[]): string[] {
  return items.flatMap((i) => (i.children ? i.children.map((c) => c.to) : i.to ? [i.to] : []));
}

/**
 * Sidebar cho MỌI vai (app-shell): icon + nhãn + badge số (Tài sản/Phần mềm/Duyệt), mục cha
 * dạng dropdown gấp gọn. Footer = khối user (nút thu gọn + tên) + Hồ sơ/VI-EN/theme/Đăng xuất
 * (thay header cũ, KHÔNG avatar). Rail (icon-only) do `.app-shell.collapsed` ở CSS lo.
 */
export function SidebarNav({
  me,
  role,
  pathname,
  collapsed,
  onToggleCollapse,
  onNavigate,
  onLogout,
}: {
  me: Me;
  role: string;
  pathname: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNavigate: () => void;
  onLogout: () => void;
}) {
  const { t, i18n } = useTranslation();
  const isVi = i18n.language.startsWith('vi');
  const groups = useMemo(() => navGroups(role), [role]);
  const isAdmin = role === 'admin' || role === 'sa';
  // Hồ sơ mở dạng popup (không rời trang đang xem) — feedback UI.
  const [profileOpen, setProfileOpen] = useState(false);
  const counts = useNavCounts(isAdmin);

  const activeTo = useMemo(() => {
    let best: string | null = null;
    let bestLen = 0;
    for (const to of groups.flatMap((g) => allTargets(g.items))) {
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
        best = to;
      }
    }
    return best;
  }, [groups, pathname]);

  const badgeFor = (key: string) => {
    const n = counts[key];
    if (n == null) return null;
    // Duyệt: chỉ hiện khi >0 (nav.lending); Tài sản/Phần mềm hiện tổng.
    if (key === 'nav.lending') {
      return n > 0 ? <span className="nav-badge warn">{n}</span> : null;
    }
    return <span className="nav-badge">{n}</span>;
  };

  return (
    <>
      <div className="brand">
        <span className="brand-mark">QL</span>
        <span className="lbl">QLTS</span>
      </div>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="nav-label">{t(group.label)}</div>
          {group.items.map((item) =>
            item.children ? (
              <NavDropdown
                key={item.key}
                item={item}
                activeTo={activeTo}
                onNavigate={onNavigate}
              />
            ) : (
              <NavLink
                key={item.to}
                to={item.to!}
                end
                onClick={onNavigate}
                className={item.to === activeTo ? 'nav-item active' : 'nav-item'}
                title={t(item.key)}
              >
                <NavIcon navKey={item.key} />
                <span className="lbl">{t(item.key)}</span>
                {badgeFor(item.key)}
              </NavLink>
            ),
          )}
        </div>
      ))}
      <div className="sb-foot">
        <div className="sb-user">
          <button
            type="button"
            className="sb-collapse"
            aria-label={t('app.toggleNav', 'Thu gọn menu')}
            title={collapsed ? t('app.expandNav', 'Mở rộng') : t('app.toggleNav', 'Thu gọn menu')}
            onClick={onToggleCollapse}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <span className="sb-who lbl">
            <b>{me.fullName ?? me.sub}</b>
            <span>{isAdmin ? t('nav.roleAdmin', 'Quản trị viên') : t('nav.roleMember', 'Thành viên')}</span>
          </span>
        </div>
        <div className="sb-actions lbl">
          <button
            type="button"
            className="sb-act"
            onClick={() => {
              setProfileOpen(true);
              onNavigate();
            }}
          >
            {t('profile.myProfile', 'Hồ sơ')}
          </button>
          <div className="sb-act-row">
            <button
              type="button"
              className="sb-act"
              onClick={() => void i18n.changeLanguage(isVi ? 'en' : 'vi')}
            >
              {t('app.language', 'Ngôn ngữ')}
              <span className="sb-badge">{isVi ? 'EN' : 'VI'}</span>
            </button>
            <ThemeSwitch />
          </div>
          <button type="button" className="sb-act danger" onClick={onLogout}>
            {t('app.logout')}
          </button>
        </div>
      </div>
      {profileOpen && (
        <Suspense fallback={null}>
          <ProfileDialog me={me} onClose={() => setProfileOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

function NavDropdown({
  item,
  activeTo,
  onNavigate,
}: {
  item: NavItem;
  activeTo: string | null;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const childActive = item.children!.some((c) => c.to === activeTo);
  const [open, setOpen] = useState(childActive);
  // Vào 1 route con thì tự mở; nhưng cho phép người dùng thu lại (không ép mở theo childActive).
  useEffect(() => {
    if (childActive) setOpen(true);
  }, [childActive]);
  const expanded = open;
  return (
    <div className="nav-dropdown">
      <button
        type="button"
        className={`nav-item nav-parent${childActive ? ' active' : ''}`}
        aria-expanded={expanded}
        title={t(item.key)}
        onClick={() => setOpen((v) => !v)}
      >
        <NavIcon navKey={item.key} />
        <span className="lbl">{t(item.key)}</span>
        <span className={`nav-caret lbl${expanded ? ' open' : ''}`} aria-hidden="true">
          ›
        </span>
      </button>
      {expanded && (
        <div className="nav-children">
          {item.children!.map((c) => (
            <NavLink
              key={c.to}
              to={c.to}
              end
              onClick={onNavigate}
              className={c.to === activeTo ? 'nav-item active' : 'nav-item'}
            >
              <span className="lbl">{t(c.key)}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

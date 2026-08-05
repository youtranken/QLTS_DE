import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { navGroups, type NavItem } from '@/shell/app-nav';
import { NavIcon } from '@/ui/nav-icon';
import { ThemeSwitch } from '@/ui/switches';
import { useNavCounts } from '@/shell/use-nav-counts';
import type { Me } from '@/lib/me';

// Lazy: giữ Hồ sơ (profile) ở chunk riêng — sidebar luôn tải nên không nhồi profile vào chunk chính.
const ProfileDialog = lazy(() =>
  import('@/features/profile/profile-dialog').then((m) => ({ default: m.ProfileDialog })),
);

// Icon menu tài khoản (inline SVG — QLTS không dùng thư viện icon). 16px, stroke currentColor.
function SbIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="sb-ico"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}
const IconUser = () => (
  <SbIcon>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
  </SbIcon>
);
const IconGlobe = () => (
  <SbIcon>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18" />
  </SbIcon>
);
const IconLogout = () => (
  <SbIcon>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </SbIcon>
);

// 2 chữ cái đầu cho avatar (rail thu gọn vẫn nhận ra user). "Nguyễn Văn An" → "NA".
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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
  // Menu tài khoản ẩn mặc định — bấm tên mới bung (Hồ sơ/Ngôn ngữ/Theme/Đăng xuất).
  const [menuOpen, setMenuOpen] = useState(false);
  const footRef = useRef<HTMLDivElement>(null);
  const counts = useNavCounts(isAdmin);

  // Đóng menu tài khoản khi bấm ra ngoài hoặc nhấn Esc.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!footRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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
    // Duyệt + Cảnh báo EOL: chỉ hiện khi >0 (việc cần xử lý). Tài sản/Phần mềm hiện tổng.
    if (key === 'nav.lending' || key === 'nav.eol') {
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
                title={item.key === 'nav.eol' ? t('nav.eolTooltip', 'End of life') : t(item.key)}
              >
                <NavIcon navKey={item.key} />
                <span className="lbl">{t(item.key)}</span>
                {badgeFor(item.key)}
              </NavLink>
            ),
          )}
        </div>
      ))}
      <div className="sb-foot" ref={footRef}>
        <div className="sb-user">
          {/* Rail thu gọn: ẩn nút hamburger — avatar user kiêm luôn nút mở rộng (QLHS). */}
          {!collapsed && (
            <button
              type="button"
              className="sb-collapse"
              aria-label={t('app.toggleNav', 'Thu gọn menu')}
              title={t('app.toggleNav', 'Thu gọn menu')}
              onClick={onToggleCollapse}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
          )}
          {/* Thu gọn: bấm avatar → BUNG sidebar (không mở menu). Mở rộng: bấm → menu tài khoản. */}
          <button
            type="button"
            className="sb-userbtn"
            aria-haspopup={collapsed ? undefined : 'menu'}
            aria-expanded={collapsed ? undefined : menuOpen}
            title={collapsed ? t('app.expandNav', 'Mở rộng') : t('app.accountMenu', 'Tài khoản')}
            onClick={() => (collapsed ? onToggleCollapse() : setMenuOpen((v) => !v))}
          >
            <span className="sb-av" aria-hidden>{initials(me.fullName ?? me.sub)}</span>
            <span className="sb-who lbl">
              <b>{me.fullName ?? me.sub}</b>
              <span>{isAdmin ? t('nav.roleAdmin', 'Quản trị viên') : t('nav.roleMember', 'Thành viên')}</span>
            </span>
          </button>
        </div>
        <div className={`sb-actions lbl${menuOpen ? ' open' : ''}`} role="menu">
          <button
            type="button"
            className="sb-act"
            onClick={() => {
              setMenuOpen(false);
              setProfileOpen(true);
              onNavigate();
            }}
          >
            <IconUser />
            {t('profile.myProfile', 'Hồ sơ')}
          </button>
          <div className="sb-act-row">
            <button
              type="button"
              className="sb-act"
              onClick={() => void i18n.changeLanguage(isVi ? 'en' : 'vi')}
            >
              <IconGlobe />
              {t('app.language', 'Ngôn ngữ')}
              <span className="sb-badge">{isVi ? 'EN' : 'VI'}</span>
            </button>
            <ThemeSwitch />
          </div>
          <button
            type="button"
            className="sb-act danger"
            onClick={() => {
              setMenuOpen(false);
              onLogout();
            }}
          >
            <IconLogout />
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

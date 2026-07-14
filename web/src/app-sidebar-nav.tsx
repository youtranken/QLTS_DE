import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { navGroups, type NavItem } from './app-nav';
import { NavIcon } from './nav-icon';
import { useNavCounts } from './use-nav-counts';
import type { Me } from './panels';

/** Mọi đích điều hướng (kể cả mục con của dropdown) — để tính "prefix dài nhất thắng". */
function allTargets(items: NavItem[]): string[] {
  return items.flatMap((i) => (i.children ? i.children.map((c) => c.to) : i.to ? [i.to] : []));
}

/** Chữ cái đầu cho avatar footer (tối đa 2 ký tự). */
function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/**
 * Sidebar theo vai (app-shell): icon + nhãn + badge số (Tài sản/Phần mềm/Duyệt), mục cha dạng
 * dropdown gấp gọn, footer avatar + tên + vai. Tách khỏi App.tsx (§6). Rail (icon-only) do
 * `.app-shell.collapsed` ở CSS lo — component chỉ bọc nhãn trong .lbl để ẩn khi thu gọn.
 */
export function SidebarNav({
  me,
  role,
  pathname,
  onNavigate,
}: {
  me: Me;
  role: string;
  pathname: string;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => navGroups(role), [role]);
  const isAdmin = role === 'admin' || role === 'sa';
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
        <span className="sb-av">{initials(me.fullName ?? me.sub)}</span>
        <span className="sb-who lbl">
          <b>{me.fullName ?? me.sub}</b>
          <span>{isAdmin ? t('nav.roleAdmin', 'Quản trị viên') : t('nav.roleMember', 'Thành viên')}</span>
        </span>
      </div>
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

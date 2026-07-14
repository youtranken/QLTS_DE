import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { navGroups, type NavItem } from './app-nav';

/** Mọi đích điều hướng (kể cả mục con của dropdown) — để tính "prefix dài nhất thắng". */
function allTargets(items: NavItem[]): string[] {
  return items.flatMap((i) => (i.children ? i.children.map((c) => c.to) : i.to ? [i.to] : []));
}

/**
 * Sidebar theo vai + tính mục đang sáng (prefix dài nhất thắng, xem app-nav). Mục có `children`
 * hiện dạng dropdown gấp gọn (vd "Kho thanh lý" → Thiết bị / Phần mềm); tự mở khi 1 con đang sáng.
 * Tách khỏi App.tsx (§6) — App chỉ dựng khung shell.
 */
export function SidebarNav({
  role,
  pathname,
  onNavigate,
}: {
  role: string;
  pathname: string;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => navGroups(role), [role]);

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

  return (
    <>
      <div className="brand">
        <span className="brand-mark">QL</span> QLTS
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
              >
                {t(item.key)}
              </NavLink>
            ),
          )}
        </div>
      ))}
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
  const expanded = open || childActive;
  return (
    <div className="nav-dropdown">
      <button
        type="button"
        className={`nav-item nav-parent${childActive ? ' active' : ''}`}
        aria-expanded={expanded}
        onClick={() => setOpen((v) => !v)}
      >
        {t(item.key)}
        <span className="nav-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
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
              {t(c.key)}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

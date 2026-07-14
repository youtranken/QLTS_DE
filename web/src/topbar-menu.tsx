import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/**
 * Nút avatar ở topbar (app-shell) mở menu: Hồ sơ · Đổi ngôn ngữ (VI/EN) · Đăng xuất.
 * Gom các nút rời của topbar cũ. Đóng khi bấm ngoài / Esc.
 */
export function TopbarMenu({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const name = me.fullName ?? me.sub;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const isVi = i18n.language.startsWith('vi');

  return (
    <div className="tb-menu" ref={ref}>
      <button
        type="button"
        className="tb-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        onClick={() => setOpen((v) => !v)}
      >
        {initials(name)}
      </button>
      {open && (
        <div className="tb-dropdown" role="menu">
          <div className="tb-dd-head">
            <b>{name}</b>
            <span>{me.sub}</span>
          </div>
          <Link
            className="tb-dd-item"
            to="/ho-so"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            {t('profile.myProfile', 'Hồ sơ')}
          </Link>
          <button
            type="button"
            className="tb-dd-item"
            role="menuitem"
            onClick={() => void i18n.changeLanguage(isVi ? 'en' : 'vi')}
          >
            {t('app.language', 'Ngôn ngữ')}
            <span className="tb-dd-badge">{isVi ? 'EN' : 'VI'}</span>
          </button>
          <button
            type="button"
            className="tb-dd-item danger"
            role="menuitem"
            onClick={onLogout}
          >
            {t('app.logout')}
          </button>
        </div>
      )}
    </div>
  );
}

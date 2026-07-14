import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface RowAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Menu "⋯" gom thao tác hàng (Sửa/Xóa/Thanh lý…). Menu dùng position:fixed neo theo nút
 * (getBoundingClientRect) để KHÔNG bị .table-wrap (overflow) cắt — trước đây absolute nên
 * "tràn xuống"/bị che. Tự lật LÊN khi dưới thiếu chỗ. Đóng khi bấm overlay.
 */
export function RowActionsMenu({ actions }: { actions: RowAction[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Toạ độ fixed chốt lúc mở; cuộn/resize làm nó trôi khỏi nút → đóng menu thay vì lơ lửng.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (actions.length === 0) return null;

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const menuH = actions.length * 36 + 12; // ước lượng để quyết định lật lên/xuống
      const below = window.innerHeight - r.bottom;
      const top = below < menuH && r.top > menuH ? r.top - menuH - 4 : r.bottom + 4;
      setPos({ top, right: window.innerWidth - r.right });
    }
    setOpen(true);
  };

  return (
    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className="sm kebab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('assets.rowActions', 'Thao tác')}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        ⋯
      </button>
      {open && pos && (
        <>
          <div className="row-actions-overlay" onClick={() => setOpen(false)} />
          <div
            className="row-actions-menu fixed"
            role="menu"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
          >
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                className={a.danger ? 'sm ghost danger' : 'sm ghost'}
                onClick={() => {
                  setOpen(false);
                  a.onClick();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

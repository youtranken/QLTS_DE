import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface RowAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Menu "⋯" gom thao tác hàng (Sửa/Xóa/Copy/Tái sử dụng) cho bảng /tai-san gọn.
 * Đóng khi bấm ra ngoài (overlay fixed); dừng nổi bọt để không kích onRowClick.
 */
export function RowActionsMenu({ actions }: { actions: RowAction[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;
  return (
    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="sm kebab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('assets.rowActions', 'Thao tác')}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="row-actions-overlay" onClick={() => setOpen(false)} />
          <div className="row-actions-menu" role="menu">
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

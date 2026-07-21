import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAnchoredMenu } from './ui/use-anchored-menu';

export interface RowAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Menu "⋯" gom thao tác hàng (Sửa/Xóa/Thanh lý…). Floating UI (useAnchoredMenu) neo theo
 * nút + flip/shift → KHÔNG bị .table-wrap (overflow) cắt; autoUpdate cho menu bám nút khi cuộn.
 * Đóng khi bấm overlay.
 */
export function RowActionsMenu({ actions }: { actions: RowAction[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles } = useAnchoredMenu(open, {
    placement: 'bottom-end',
    maxHeight: 400,
  });

  if (actions.length === 0) return null;

  return (
    <div
      className="row-actions"
      ref={refs.setReference}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="sm kebab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('assets.rowActions', 'Thao tác')}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="row-actions-overlay" onClick={() => setOpen(false)} />
          <div
            className="row-actions-menu fixed"
            role="menu"
            ref={refs.setFloating}
            style={floatingStyles}
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

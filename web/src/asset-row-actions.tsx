import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAnchoredMenu } from './ui/use-anchored-menu';

/** Loại hành động → icon (tách bạch Thanh lý=lưu kho vs Xóa=thùng rác). */
export type ActionKind =
  | 'edit'
  | 'copy'
  | 'reuse'
  | 'view'
  | 'unlock'
  | 'lock'
  | 'poolOn'
  | 'poolOff'
  | 'link'
  | 'dispose'
  | 'delete'
  | 'detach';

export interface RowAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
  icon?: ActionKind;
}

const P: Record<ActionKind, ReactNode> = {
  edit: (
    <>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  reuse: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  view: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  link: (
    <>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
      <path d="M8 12h8" />
    </>
  ),
  unlock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  poolOn: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8M12 8v8" />
    </>
  ),
  poolOff: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8" />
    </>
  ),
  dispose: (
    <>
      <rect x="2" y="4" width="20" height="5" rx="1" />
      <path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </>
  ),
  delete: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  detach: (
    <>
      <path d="m18.84 12.25 1.72-1.71a4 4 0 0 0-5.66-5.66l-1.71 1.72" />
      <path d="m5.17 11.75-1.71 1.71a4 4 0 0 0 5.66 5.66l1.71-1.71" />
      <path d="m2 2 20 20" />
    </>
  ),
};

function ActionIcon({ kind }: { kind: ActionKind }) {
  return (
    <svg
      className="ra-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {P[kind]}
    </svg>
  );
}

/**
 * Menu "⋯" gom thao tác hàng (Sửa/Xóa/Thanh lý…). Floating UI (useAnchoredMenu) neo theo
 * nút + flip/shift → KHÔNG bị .table-wrap (overflow) cắt; autoUpdate cho menu bám nút khi cuộn.
 * Đóng khi bấm overlay. Icon dẫn đầu (tách Thanh lý=lưu kho vs Xóa=thùng rác).
 */
export function RowActionsMenu({ actions }: { actions: RowAction[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles } = useAnchoredMenu(open, {
    placement: 'bottom-end',
    maxHeight: 400,
  });

  // Cuộn (kể cả trong .table-wrap) → đóng menu, tránh menu (fixed) nổi tách khi nút
  // chui dưới thead sticky. capture=true để bắt cả cuộn container.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [open]);

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
                {a.icon && <ActionIcon kind={a.icon} />}
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

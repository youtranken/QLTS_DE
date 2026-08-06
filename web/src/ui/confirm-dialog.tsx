import { useTranslation } from 'react-i18next';
import { Dialog, DialogTitle, DialogDescription, DialogClose } from '@/ui/dialog';

/**
 * Hộp thoại xác nhận dùng chung — thay window.confirm cho các thao tác nguy hiểm
 * (vd Xóa vĩnh viễn). Dựng trên Radix Dialog (ui/dialog.tsx): focus trap, scroll-lock,
 * Esc, trả focus, aria-labelledby đều có sẵn. Nút xác nhận đỏ khi danger.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      // Đóng qua Esc / click-ngoài / nút ✕ → onCancel; chặn khi đang busy.
      onOpenChange={(o) => {
        if (!o && !busy) onCancel();
      }}
      dismissible={!busy}
      maxWidth={440}
    >
      <div className="sheet-header">
        <DialogTitle className="sheet-title">{title}</DialogTitle>
        <span className="spacer" />
        <DialogClose asChild>
          <button
            type="button"
            className="sheet-close"
            aria-label={cancelLabel ?? t('assets.cancel')}
            disabled={busy}
          >
            ✕
          </button>
        </DialogClose>
      </div>
      <div className="sheet-body">
        {error && <p role="alert" className="alert error">{error}</p>}
        <DialogDescription style={{ margin: 0 }}>{message}</DialogDescription>
      </div>
      <div className="sheet-footer">
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={onCancel}>
          {cancelLabel ?? t('assets.cancel')}
        </button>
        <button
          type="button"
          className={danger ? 'danger' : 'primary'}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

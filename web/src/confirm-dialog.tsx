import { useTranslation } from 'react-i18next';

/**
 * Hộp thoại xác nhận dùng chung — thay window.confirm cho các thao tác nguy hiểm
 * (vd Xóa vĩnh viễn). Cùng khung .sheet với các dialog khác. Nút xác nhận đỏ khi danger.
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
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 440 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <span className="sheet-title">{title}</span>
          <span className="spacer" />
          <button
            type="button"
            className="sheet-close"
            aria-label={cancelLabel ?? t('assets.cancel')}
            disabled={busy}
            onClick={onCancel}
          >
            ✕
          </button>
        </div>
        <div className="sheet-body">
          {error && <p className="alert error">{error}</p>}
          <p style={{ margin: 0 }}>{message}</p>
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
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

/**
 * Duyệt/từ chối 1 yêu cầu gia hạn treo NGAY từ bảng "Máy đang mượn" (nút Duyệt trên row có cờ
 * Đang chờ gia hạn). Hiển thị ngày/giờ member đã xin (oldDue → newDue) để admin quyết.
 * Dùng chung endpoint với hàng đợi Chờ gia hạn: POST admin/tickets/extensions/:id/approve|reject.
 */
export function ExtensionApproveDialog({
  me,
  assetCode,
  extensionId,
  extVersion,
  oldDue,
  newDue,
  usedCount,
  onClose,
  onDone,
}: {
  me: Me;
  assetCode: string | null;
  extensionId: string;
  extVersion: number;
  oldDue: string | null;
  newDue: string | null;
  usedCount: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
          timeZone: 'Asia/Ho_Chi_Minh',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  const act = async (kind: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/tickets/extensions/${extensionId}/${kind}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify(
            kind === 'reject'
              ? { version: extVersion, reason: reason.trim() }
              : { version: extVersion },
          ),
        },
      );
      if (res.ok) {
        onDone();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      const map: Record<string, string> = {
        STALE_VERSION: t('extapprove.errStale'),
        EXTENSION_EXPIRED: t('extapprove.errExpired'),
        INVALID_STATE: t('extapprove.errState'),
      };
      setError((body.code && map[body.code]) || t('extapprove.error'));
    } catch {
      setError(t('extapprove.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: '0.75rem' }}>
          {t('extapprove.title')} <span className="mono">{assetCode}</span>
        </h2>
        <p className="muted" style={{ marginBottom: '0.35rem' }}>
          {t('extension.usedCount', { n: usedCount })}
        </p>
        {/* Ngày/giờ member đã xin gia hạn: hạn cũ → hạn mới (yêu cầu hiển thị khi bấm Duyệt). */}
        <p style={{ marginBottom: '1rem', fontWeight: 600 }}>
          {fmt(oldDue)} <span className="muted">→</span> {fmt(newDue)}
        </p>
        {error && <p className="alert error">{error}</p>}
        {rejecting ? (
          <label className="field" style={{ marginBottom: '1rem' }}>
            <span>{t('extapprove.reasonPlaceholder')}</span>
            <input
              value={reason}
              autoFocus
              disabled={busy}
              placeholder={t('extapprove.reasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        ) : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {rejecting ? (
            <>
              <button type="button" disabled={busy} onClick={() => setRejecting(false)}>
                {t('extapprove.cancel')}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || reason.trim() === ''}
                onClick={() => void act('reject')}
              >
                {t('extapprove.confirmReject')}
              </button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={onClose}>
                {t('extension.cancel')}
              </button>
              <button
                type="button"
                className="ghost danger"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                {t('extapprove.reject')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void act('approve')}
              >
                {t('extapprove.approve')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

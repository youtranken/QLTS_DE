import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './me';

/**
 * Nút "Hủy" (đỏ) — Admin hủy CƯỠNG CHẾ lượt mượn của người khác (audit H-2).
 * Dùng chung cho hàng đợi Xử lý mượn và bảng Máy đang mượn ở trang chủ.
 *
 * Lý do BẮT BUỘC: BE chặn 400 nếu rỗng, và nguyên văn lý do được gửi mail cho
 * người mượn — nên placeholder phải nói rõ điều đó, tránh admin gõ cho có.
 */
export function ForceCancelButton({
  ticketId,
  me,
  onDone,
  disabled,
}: {
  ticketId: string;
  me: Me;
  onDone: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const r = reason.trim();
    if (r === '') return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/tickets/${ticketId}/force-cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({ reason: r }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(body.message ?? t('forceCancel.failed'));
        return;
      }
      setOpen(false);
      setReason('');
      onDone();
    } catch {
      setError(t('forceCancel.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="danger sm"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          setReason('');
          setError(null);
        }}
      >
        {t('forceCancel.button')}
      </button>
    );
  }

  return (
    <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <input
        value={reason}
        autoFocus
        placeholder={t('forceCancel.reasonPlaceholder')}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        style={{ minWidth: 200 }}
      />
      <button
        type="button"
        className="danger sm"
        disabled={busy || reason.trim() === ''}
        onClick={() => void submit()}
      >
        {t('forceCancel.confirm')}
      </button>
      <button
        type="button"
        className="sm"
        disabled={busy}
        onClick={() => {
          setOpen(false);
          setReason('');
          setError(null);
        }}
      >
        {t('forceCancel.abort')}
      </button>
      {error && <span className="alert error sm">{error}</span>}
    </span>
  );
}

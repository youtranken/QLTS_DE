import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTimePicker } from '@/ui/date-time-picker';
import { Dialog, DialogTitle, DialogDescription } from '@/ui/dialog';
import type { Me } from '@/lib/me';

/**
 * Dialog gia hạn dùng chung cho bảng "Máy đang mượn".
 * - mode 'member' (đường A): xin gia hạn → chờ admin duyệt (POST my-tickets/:id/extension, cần version).
 * - mode 'admin'  (đường B): admin đặt hạn trả mới NGAY (POST admin/tickets/:id/extend, không version).
 */
export function ExtensionDialog({
  me,
  ticketId,
  assetCode,
  due,
  version,
  extensionCount,
  mode,
  onClose,
  onDone,
}: {
  me: Me;
  ticketId: string;
  assetCode: string | null;
  due: string | null;
  version: number;
  extensionCount: number;
  mode: 'member' | 'admin';
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [newDue, setNewDue] = useState('');
  const [busy, setBusy] = useState(false);
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

  const submit = async () => {
    if (!newDue) return;
    setBusy(true);
    setError(null);
    try {
      const url =
        mode === 'admin'
          ? `/api/admin/tickets/${ticketId}/extend`
          : `/api/booking/my-tickets/${ticketId}/extension`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify(
          mode === 'admin'
            ? { newDue: new Date(newDue).toISOString() }
            : { newDue: new Date(newDue).toISOString(), version },
        ),
      });
      if (res.ok || res.status === 201) {
        onDone();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      const map: Record<string, string> = {
        SLOT_TAKEN: t('extension.errSlot'),
        ASSET_UNAVAILABLE: t('extension.errSlot'),
        EXTENSION_TOO_LONG: t('extension.errTooLong'),
        EXTENSION_LIMIT: t('extension.errLimit'),
        EXTENSION_PENDING: t('extension.errPending'),
        TICKET_OVERDUE: t('extension.errOverdue'),
        INVALID_RANGE: t('extension.errRange'),
        STALE_VERSION: t('extension.errStale'),
      };
      setError((body.code && map[body.code]) || t('extension.errGeneric'));
    } catch {
      setError(t('extension.errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      dismissible={!busy}
      className="modal"
    >
      <DialogTitle style={{ marginBottom: '0.75rem' }}>
        {mode === 'admin' ? t('extension.titleAdmin') : t('extension.title')}{' '}
        <span className="mono">{assetCode}</span>
      </DialogTitle>
      <DialogDescription className="muted" style={{ marginBottom: '0.75rem' }}>
        {t('extension.currentDue')}: <strong>{fmt(due)}</strong>
        {' · '}
        {t('extension.usedCount', { n: extensionCount })}
      </DialogDescription>
      {error && <p role="alert" className="alert error">{error}</p>}
      <label className="field" style={{ marginBottom: '1.25rem' }}>
        {t('extension.newDue')}
        <DateTimePicker
          value={newDue}
          min={due ?? undefined}
          ariaLabel={t('extension.newDue')}
          onChange={setNewDue}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" disabled={busy} onClick={onClose}>
          {t('extension.cancel')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !newDue}
          onClick={() => void submit()}
        >
          {busy
            ? t('extension.submitting')
            : mode === 'admin'
              ? t('extension.submitAdmin')
              : t('extension.submit')}
        </button>
      </div>
    </Dialog>
  );
}

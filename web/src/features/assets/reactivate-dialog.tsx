import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogClose, DialogTitle } from '@/ui/dialog';
import type { AssetDetail, AssetRow } from '@/lib/asset-types';
import type { Me } from '@/lib/me';

/**
 * Tái sử dụng máy đã thanh lý (VĐ2) — hồi sinh CHÍNH máy đó (disposed → in_use), GIỮ mã MTS
 * cũ mặc định; cho đổi sang mã khác (trùng máy đang dùng → BE trả 409, hiện cảnh báo).
 * Đọc version tươi trước khi gửi (optimistic lock như các dialog khác).
 */
export function ReactivateDialog({
  me,
  asset,
  onDone,
}: {
  me: Me;
  asset: AssetRow;
  onDone: (changed: boolean) => void;
}) {
  const { t } = useTranslation();
  const [version, setVersion] = useState<number | null>(null);
  const [code, setCode] = useState(asset.code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/assets/${encodeURIComponent(asset.id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<AssetDetail>) : null))
      .then((d) => alive && d && setVersion(d.version))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [asset.id]);

  const run = async () => {
    if (version == null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/assets/${encodeURIComponent(asset.id)}/reactivate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({ version, code: code.trim() || null }),
        },
      );
      if (res.ok) {
        onDone(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      // 409 mã trùng → BE trả message "mã đã tồn tại" (cảnh báo đổi mã).
      setError(body?.message ?? t('assets.reactivateFailed', 'Không tái sử dụng được máy này.'));
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  };

  const changedCode = code.trim() !== (asset.code ?? '');

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onDone(false)}
      dismissible={!busy}
      className="sheet"
      maxWidth={460}
    >
      <div className="sheet-header">
        <DialogTitle className="sheet-title">
          {t('assets.reuse', 'Tái sử dụng')}
          {asset.code ? <span className="mono"> · {asset.code}</span> : null}
        </DialogTitle>
        <span className="spacer" />
        <DialogClose asChild>
          <button
            type="button"
            className="sheet-close"
            aria-label={t('app.close', 'Đóng')}
            disabled={busy}
          >
            ✕
          </button>
        </DialogClose>
      </div>
      <div className="sheet-body">
        {error && <p className="alert error">{error}</p>}
        <p className="hint">
          {t(
            'assets.reactivateHint',
            'Máy sẽ trở lại "đang dùng". Giữ nguyên mã cũ, hoặc nhập mã khác để đổi.',
          )}
        </p>
        <label className="field">
          <span>{t('assets.reactivateCode', 'Mã tài sản (MTS)')}</span>
          <input
            value={code}
            disabled={busy}
            maxLength={100}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
      </div>
      <div className="sheet-footer">
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={() => onDone(false)}>
          {t('assets.cancel')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || version == null}
          onClick={() => void run()}
        >
          {changedCode
            ? t('assets.reactivateWithNewCode', 'Tái sử dụng (đổi mã)')
            : t('assets.reactivateKeepCode', 'Tái sử dụng (giữ mã)')}
        </button>
      </div>
    </Dialog>
  );
}

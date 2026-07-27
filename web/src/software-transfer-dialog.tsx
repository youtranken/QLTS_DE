import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogTitle, DialogClose } from '@/ui/dialog';
import type { AssetDetail, AssetRow } from '@/asset-types';
import type { Me } from '@/me';

/**
 * Gán 1 bản (seat) phần mềm vào máy — hoặc gỡ về "chưa gắn". Dùng lại PUT :id/transfer (2.5).
 * Combobox GỢI Ý SẴN (nạp máy chưa thanh lý ngay khi mở, gõ để lọc thêm). Tự đọc version tươi.
 */
export function SoftwareTransferDialog({
  me,
  softwareId,
  currentHostCode,
  onDone,
}: {
  me: Me;
  softwareId: string;
  currentHostCode: string | null | undefined;
  onDone: (changed: boolean) => void;
}) {
  const { t } = useTranslation();
  const [version, setVersion] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<AssetRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/assets/${encodeURIComponent(softwareId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<AssetDetail>) : null))
      .then((d) => alive && d && setVersion(d.version))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [softwareId]);

  // Gợi ý sẵn: nạp danh sách máy (chưa thanh lý) ngay khi mở; gõ để lọc (debounce). Loại
  // chính máy đang gắn khỏi gợi ý (chọn nó là no-op).
  useEffect(() => {
    const c = new AbortController();
    const q = query.trim();
    const timer = setTimeout(
      () => {
        fetch(
          `/api/admin/assets?excludeSoftware=true&excludeDisposed=true&page=1&pageSize=50${
            q ? `&search=${encodeURIComponent(q)}` : ''
          }`,
          { signal: c.signal },
        )
          .then((r) => (r.ok ? (r.json() as Promise<{ items?: AssetRow[] }>) : { items: [] }))
          .then((b) =>
            setOptions(
              (b.items ?? []).filter(
                (a) => a.status !== 'disposed' && a.code !== currentHostCode,
              ),
            ),
          )
          .catch(() => undefined);
      },
      q ? 250 : 0,
    );
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [query, currentHostCode]);

  const run = async (targetAssetId: string | null) => {
    if (version == null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/assets/${encodeURIComponent(softwareId)}/transfer`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({
            ...(targetAssetId ? { targetAssetId } : {}),
            version,
          }),
        },
      );
      if (res.ok) {
        onDone(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      setError(body?.message ?? t('assets.transferFailed'));
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onDone(false)}
      dismissible={!busy}
      className="sheet assign-sheet"
      maxWidth={540}
    >
      <div className="sheet-header">
        <DialogTitle className="sheet-title">{t('software.assignTitle')}</DialogTitle>
        <span className="spacer" />
        <DialogClose asChild>
          <button
            type="button"
            className="sheet-close"
            aria-label={t('assets.cancel')}
            disabled={busy}
          >
            ✕
          </button>
        </DialogClose>
      </div>
      <div className="sheet-body">
          {error && <p className="alert error">{error}</p>}

          <div className="assign-current">
            <span className="assign-current-label">{t('software.currentHost')}</span>
            {currentHostCode ? (
              <span className="mono assign-host-chip">{currentHostCode}</span>
            ) : (
              <span className="muted">{t('software.notAssignedYet')}</span>
            )}
          </div>

          <label className="field assign-pick">
            <span>{t('software.pickMachine')}</span>
            <input
              className="assign-search"
              type="search"
              autoFocus
              placeholder={t('software.searchMachine')}
              value={query}
              disabled={busy || version == null}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="assign-list" role="listbox">
            {options.length === 0 ? (
              <p className="assign-empty">{t('assets.noMatch')}</p>
            ) : (
              options.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  className="assign-opt"
                  disabled={busy || version == null}
                  onClick={() => void run(a.id)}
                >
                  <span className="mono">{a.code}</span>
                  {/* Dòng phụ NHẤT QUÁN: luôn hiện loại máy, kèm người giữ nếu máy có chủ. */}
                  <small>
                    {a.type ?? '—'}
                    {a.assignedUserName ? ` · ${a.assignedUserName}` : ''}
                  </small>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="sheet-footer">
          {currentHostCode && (
            <button
              type="button"
              className="ghost danger"
              disabled={busy || version == null}
              onClick={() => void run(null)}
            >
              {t('software.detachHost')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={() => onDone(false)}>
            {t('assets.cancel')}
          </button>
        </div>
    </Dialog>
  );
}

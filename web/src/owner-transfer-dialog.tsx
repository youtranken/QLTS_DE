import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import type { AssetDetail, AssetRow, UserOption } from './asset-types';
import type { Me } from './panels';

/**
 * Chuyển máy sang người khác = đổi người đứng tên (assignOwner, PUT :id/assignee).
 * Phần mềm cài trên máy TỰ theo người mới (holder derive theo máy) → hiện số lượng để nhắc.
 * Người nhận chọn qua Combobox gợi ý sẵn (nạp trang đầu khi mở, gõ tên/email để lọc).
 * Tự đọc version tươi trước khi gửi (optimistic lock như form).
 */
export function OwnerTransferDialog({
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
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<UserOption[]>([]);
  const [picked, setPicked] = useState<UserOption | null>(null);
  const [note, setNote] = useState('');
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

  // Gợi ý sẵn: nạp trang đầu ngay khi mở; gõ để lọc (debounce). Loại người đang giữ máy này
  // khỏi gợi ý (chọn lại là no-op).
  useEffect(() => {
    const c = new AbortController();
    const q = query.trim();
    const timer = setTimeout(
      () => {
        fetch(
          `/api/admin/users?page=1&pageSize=20${
            q ? `&search=${encodeURIComponent(q)}` : ''
          }`,
          { signal: c.signal },
        )
          .then((r) => (r.ok ? (r.json() as Promise<{ items?: UserOption[] }>) : { items: [] }))
          .then((b) =>
            setOptions((b.items ?? []).filter((u) => u.sub !== asset.assignedUserSub)),
          )
          .catch(() => undefined);
      },
      q ? 250 : 0,
    );
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [query, asset.assignedUserSub]);

  const swCount = asset.installedSoftware
    ? asset.installedSoftware.split(',').filter((s) => s.trim()).length
    : 0;

  const run = async () => {
    if (version == null || !picked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/assets/${encodeURIComponent(asset.id)}/assignee`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({
            assignedUserSub: picked.sub,
            version,
            allocationNote: note.trim() || null,
          }),
        },
      );
      if (res.ok) {
        onDone(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(body?.message ?? t('assets.transferOwnerFailed'));
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => onDone(false)}>
      <div
        className="sheet assign-sheet"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 540 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <span className="sheet-title">
            {t('assets.transferOwnerTitle')}
            {asset.code ? <span className="mono"> · {asset.code}</span> : null}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="sheet-close"
            aria-label={t('assets.cancel')}
            onClick={() => onDone(false)}
          >
            ✕
          </button>
        </div>
        <div className="sheet-body">
          {error && <p className="alert error">{error}</p>}

          <div className="assign-current">
            <span className="assign-current-label">{t('assets.currentHolder')}</span>
            {asset.assignedUserName ?? asset.assignedUserSub ?? null ? (
              <span className="assign-host-chip">
                {asset.assignedUserName ?? asset.assignedUserSub}
              </span>
            ) : (
              <span className="muted">{t('assets.noHolderYet')}</span>
            )}
          </div>

          <label className="field assign-pick">
            <span>{t('assets.transferOwnerPick')}</span>
            {picked ? (
              <div className="picked-input">
                <span className="pi-val">{picked.fullName ?? picked.sub}</span>
                <button
                  type="button"
                  aria-label={t('assets.cancel')}
                  disabled={busy}
                  onClick={() => setPicked(null)}
                >
                  ✕
                </button>
              </div>
            ) : (
              <Combobox
                placeholder={t('assets.transferOwnerSearch')}
                query={query}
                onQuery={setQuery}
                options={options}
                disabled={busy || version == null}
                getKey={(u) => u.sub}
                renderOption={(u) => (
                  <>
                    <span>{u.fullName ?? u.sub}</span>
                    {u.email && <small>{u.email}</small>}
                  </>
                )}
                onSelect={(u) => {
                  setPicked(u);
                  setQuery('');
                  setOptions([]);
                }}
              />
            )}
          </label>

          {swCount > 0 && (
            <p className="hint">{t('assets.softwareFollows', { count: swCount })}</p>
          )}

          <label className="field">
            <span>{t('assets.handoverNote')}</span>
            <input
              maxLength={2000}
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
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
            disabled={busy || version == null || !picked}
            onClick={() => void run()}
          >
            {t('assets.transferOwnerSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}

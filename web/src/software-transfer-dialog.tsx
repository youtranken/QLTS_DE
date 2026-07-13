import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import type { AssetDetail, AssetRow } from './asset-types';
import type { Me } from './panels';

/**
 * Gắn / chuyển 1 bản (seat) phần mềm sang máy khác — hoặc gỡ về "chưa gắn máy".
 * Dùng lại endpoint PUT :id/transfer (2.5). Tự đọc version tươi (list không trả version).
 * Chỉ tìm MÁY (excludeSoftware) chưa thanh lý làm đích.
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

  useEffect(() => {
    if (!query) {
      setOptions([]);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/assets?excludeSoftware=true&search=${encodeURIComponent(query)}&page=1&pageSize=20`,
        { signal: c.signal },
      )
        .then((r) => (r.ok ? (r.json() as Promise<{ items?: AssetRow[] }>) : { items: [] }))
        .then((b) =>
          setOptions((b.items ?? []).filter((a) => a.status !== 'disposed')),
        )
        .catch(() => undefined);
    }, 300);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [query]);

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
    <div className="modal-backdrop" onClick={() => onDone(false)}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <span className="sheet-title">{t('software.assignTitle')}</span>
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
          {currentHostCode && (
            <p className="muted" style={{ marginTop: 0 }}>
              {t('software.currentHost')}:{' '}
              <span className="mono">{currentHostCode}</span>
            </p>
          )}
          <Combobox
            placeholder={t('software.searchMachine')}
            query={query}
            onQuery={setQuery}
            options={options}
            disabled={busy || version == null}
            getKey={(a) => a.id}
            renderOption={(a) => (
              <>
                <span className="mono">{a.code}</span>
                {a.assignedUserName && <small>{a.assignedUserName}</small>}
              </>
            )}
            onSelect={(a) => void run(a.id)}
          />
        </div>
        <div className="sheet-footer">
          {currentHostCode && (
            <button
              type="button"
              className="ghost"
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
      </div>
    </div>
  );
}

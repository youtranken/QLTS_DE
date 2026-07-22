import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Dialog, DialogClose, DialogTitle } from './ui/dialog';
import type { Me } from './me';

interface PreviewRow {
  rowNumber: number;
  errors: string[];
  display: Record<string, string>;
}

interface PreviewResult {
  total: number;
  valid: number;
  invalid: number;
  rows: PreviewRow[];
}

/**
 * Lõi Import (dùng chung trang + popup) — chọn file → preview dry-run → commit → rematch.
 * `onCommitted` gọi sau khi import thật thành công (để trang cha refetch danh sách).
 */
function ImportPanel({ me, onCommitted }: { me: Me; onCommitted?: () => void }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [rematchMsg, setRematchMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // đổi key để reset <input type=file> sau khi import thành công (review 2.9)
  const [inputKey, setInputKey] = useState(0);

  const post = useCallback(
    async (path: string, withFile: boolean) => {
      const form = new FormData();
      if (withFile && file) form.append('file', file);
      const res = await fetch(`/api/admin/assets-import/${path}`, {
        method: 'POST',
        headers: me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {},
        ...(withFile ? { body: form } : {}),
      });
      return res;
    },
    [file, me.csrfToken],
  );

  const runPreview = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setCommitMsg(null);
    try {
      const res = await post('preview', true);
      const body = (await res.json()) as PreviewResult & { message?: string };
      if (res.ok) {
        setPreview(body);
      } else {
        setPreview(null);
        setError(body.message ?? t('importx.previewFailed'));
      }
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [file, post, t]);

  const runCommit = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post('commit', true);
      const body = (await res.json()) as {
        created?: number;
        needsUserMatch?: number;
        message?: string;
        rowNumber?: number | null;
      };
      if (res.ok) {
        setCommitMsg(
          t('importx.commitOk', {
            created: body.created,
            needs: body.needsUserMatch,
          }),
        );
        setPreview(null);
        setFile(null);
        setInputKey((k) => k + 1);
        onCommitted?.();
      } else {
        setError(
          body.rowNumber != null
            ? `${body.message ?? ''} (${t('importx.atRow', { row: body.rowNumber })})`
            : (body.message ?? t('importx.commitFailed')),
        );
      }
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [file, post, t, onCommitted]);

  const runRematch = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post('rematch', false);
      const body = (await res.json()) as {
        matched?: number;
        remaining?: number;
        message?: string;
      };
      if (res.ok) {
        setRematchMsg(
          t('importx.rematchResult', {
            matched: body.matched,
            remaining: body.remaining,
          }),
        );
      } else {
        setError(body.message ?? t('importx.rematchFailed'));
      }
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [post, t]);

  const columns = [
    'user',
    'code',
    'type',
    'configuration',
    'cost',
    'startDate',
    'endDate',
    'floor',
    'status',
    'note',
  ] as const;

  return (
    <>
      {error && <p className="alert error">{error}</p>}
      {commitMsg && <p className="alert ok">{commitMsg}</p>}
      <div className="toolbar">
        <input
          key={inputKey}
          type="file"
          accept=".xlsx"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setCommitMsg(null);
          }}
        />
        <button type="button" disabled={busy || !file} onClick={() => void runPreview()}>
          {t('importx.preview')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !file || !preview || preview.invalid > 0}
          onClick={() => void runCommit()}
        >
          {t('importx.commit')}
        </button>
        <button type="button" disabled={busy} onClick={() => void runRematch()}>
          {t('importx.rematch')}
        </button>
        {rematchMsg && <span style={{ fontSize: '0.85rem' }}>{rematchMsg}</span>}
      </div>
      {preview && (
        <>
          <p>
            {t('importx.summary', {
              total: preview.total,
              valid: preview.valid,
              invalid: preview.invalid,
            })}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  {columns.map((c) => (
                    <th key={c}>{t(`importx.col.${c}`)}</th>
                  ))}
                  <th>{t('importx.rowErrors')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr
                    key={r.rowNumber}
                    className={r.errors.length > 0 ? 'overdue' : undefined}
                  >
                    <td>{r.rowNumber}</td>
                    {columns.map((c) => (
                      <td key={c}>
                        {c === 'code' ? (
                          <span className="mono">{r.display[c] ?? ''}</span>
                        ) : (
                          (r.display[c] ?? '')
                        )}
                      </td>
                    ))}
                    <td>
                      {r.errors.length > 0 && (
                        <span className="badge danger">{r.errors.join(' ')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/** Trang Import (route /assets/import) — giữ để không vỡ link/bookmark cũ. */
export function ImportPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/assets">‹ {t('assets.backToList')}</Link>
      </p>
      <div className="page-header">
        <h1>{t('importx.title')}</h1>
      </div>
      <ImportPanel me={me} />
    </>
  );
}

/** Popup Import — mở từ nút Import ở sổ tài sản (không rời trang). */
export function ImportDialog({
  me,
  onClose,
  onCommitted,
}: {
  me: Me;
  onClose: () => void;
  onCommitted?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      className="sheet sheet-wide"
      maxWidth={900}
    >
      <div className="sheet-header">
        <DialogTitle className="sheet-title">{t('importx.title')}</DialogTitle>
        <span className="spacer" />
        <DialogClose asChild>
          <button
            type="button"
            className="sheet-close"
            aria-label={t('app.close', 'Đóng')}
            onClick={onClose}
          >
            ✕
          </button>
        </DialogClose>
      </div>
      <div className="sheet-body">
        <ImportPanel me={me} onCommitted={onCommitted} />
      </div>
    </Dialog>
  );
}

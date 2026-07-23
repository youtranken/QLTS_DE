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

type ImportKind = 'assets' | 'software';

/** Cột preview phần mềm (VĐ4) — khớp file Export phần mềm. */
const SOFTWARE_COLS: { key: string; label: string; mono?: boolean }[] = [
  { key: 'licenseName', label: 'Tên phần mềm' },
  { key: 'installedOnCode', label: 'Máy', mono: true },
  { key: 'licenseType', label: 'Loại license' },
  { key: 'startDate', label: 'Start' },
  { key: 'endDate', label: 'End' },
  { key: 'status', label: 'Status' },
  { key: 'cost', label: 'Cost' },
  { key: 'serial', label: 'Serial' },
  { key: 'brand', label: 'Brand' },
  { key: 'note', label: 'Note' },
];
const ASSET_COL_KEYS = [
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

/**
 * Lõi Import (dùng chung trang + popup; assets/software) — chọn file → preview → commit
 * → rematch (chỉ assets). `onCommitted` gọi sau import thật thành công (cha refetch).
 */
function ImportPanel({
  me,
  kind = 'assets',
  onCommitted,
}: {
  me: Me;
  kind?: ImportKind;
  onCommitted?: () => void;
}) {
  const { t } = useTranslation();
  const base = kind === 'software' ? 'assets-import/software' : 'assets-import';
  const cols =
    kind === 'software'
      ? SOFTWARE_COLS
      : ASSET_COL_KEYS.map((k) => ({
          key: k,
          label: t(`importx.col.${k}`),
          mono: k === 'code',
        }));
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
      const res = await fetch(`/api/admin/${base}/${path}`, {
        method: 'POST',
        headers: me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {},
        ...(withFile ? { body: form } : {}),
      });
      return res;
    },
    [file, me.csrfToken, base],
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
        {kind !== 'software' && (
          <>
            <button type="button" disabled={busy} onClick={() => void runRematch()}>
              {t('importx.rematch')}
            </button>
            {rematchMsg && (
              <span style={{ fontSize: '0.85rem' }}>{rematchMsg}</span>
            )}
          </>
        )}
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
                  {cols.map((c) => (
                    <th key={c.key}>{c.label}</th>
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
                    {cols.map((c) => (
                      <td key={c.key}>
                        {c.mono ? (
                          <span className="mono">{r.display[c.key] ?? ''}</span>
                        ) : (
                          (r.display[c.key] ?? '')
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

/** Popup Import — mở từ nút Import ở sổ tài sản / phần mềm (không rời trang). */
export function ImportDialog({
  me,
  kind = 'assets',
  onClose,
  onCommitted,
}: {
  me: Me;
  kind?: ImportKind;
  onClose: () => void;
  onCommitted?: () => void;
}) {
  const { t } = useTranslation();
  const title =
    kind === 'software'
      ? t('importx.titleSoftware', 'Import phần mềm')
      : t('importx.title');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      className="sheet sheet-wide"
      maxWidth={900}
    >
      <div className="sheet-header">
        <DialogTitle className="sheet-title">{title}</DialogTitle>
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
        <ImportPanel me={me} kind={kind} onCommitted={onCommitted} />
      </div>
    </Dialog>
  );
}

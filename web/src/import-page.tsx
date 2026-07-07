import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Me } from './panels';

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

/** Import Excel go-live (story 2.9, FR-40) — preview dry-run rồi mới import thật. */
export function ImportPage({ me }: { me: Me }) {
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
  }, [file, post, t]);

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
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/tai-san">‹ {t('assets.backToList')}</Link>
      </p>
      <div className="page-header">
        <h1>{t('importx.title')}</h1>
      </div>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        {t('importx.hint')}
      </p>
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

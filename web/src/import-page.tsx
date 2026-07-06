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

const cell: React.CSSProperties = {
  padding: '0.2rem 0.6rem',
  fontSize: '0.85rem',
  verticalAlign: 'top',
};

/** Import Excel go-live (story 2.9, FR-40) — preview dry-run rồi mới import thật. */
export function ImportPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [rematchMsg, setRematchMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <h1 style={{ fontSize: '1.2rem' }}>{t('importx.title')}</h1>
      <p style={{ fontSize: '0.85rem', color: '#555' }}>
        {t('importx.hint')}
      </p>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {commitMsg && <p style={{ color: '#1e7e34' }}>{commitMsg}</p>}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          alignItems: 'center',
          marginBottom: '0.75rem',
        }}
      >
        <input
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
          disabled={busy || !file || !preview || preview.invalid > 0}
          onClick={() => void runCommit()}
          style={{ fontWeight: 600 }}
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
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={cell}>#</th>
                  {columns.map((c) => (
                    <th key={c} style={cell}>
                      {t(`importx.col.${c}`)}
                    </th>
                  ))}
                  <th style={cell}>{t('importx.rowErrors')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr
                    key={r.rowNumber}
                    style={{
                      color: r.errors.length > 0 ? '#c0392b' : undefined,
                    }}
                  >
                    <td style={cell}>{r.rowNumber}</td>
                    {columns.map((c) => (
                      <td key={c} style={cell}>
                        {r.display[c] ?? ''}
                      </td>
                    ))}
                    <td style={cell}>{r.errors.join(' ')}</td>
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

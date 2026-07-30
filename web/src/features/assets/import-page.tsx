import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Me } from '@/lib/me';

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

interface QuickResult {
  ok: boolean;
  text: string;
  errors?: { row: number; msgs: string[] }[];
}

/**
 * Import "1 chạm" (không popup): bấm nút → hiện hộp chọn file luôn → preview; file SẠCH thì
 * NẠP NGAY, có lỗi/sai cột thì liệt kê lỗi cụ thể theo dòng để sửa. `pick` mở hộp chọn file.
 */
export function useQuickImport({
  me,
  kind,
  onCommitted,
}: {
  me: Me;
  kind: ImportKind;
  onCommitted?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuickResult | null>(null);
  const base =
    kind === 'software' ? 'assets-import/software' : 'assets-import';

  const pick = useCallback(() => {
    setResult(null);
    inputRef.current?.click();
  }, []);

  // Thông báo THÀNH CÔNG tự ẩn sau 2s; lỗi giữ lại để đọc/sửa.
  useEffect(() => {
    if (!result?.ok) return;
    const id = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(id);
  }, [result]);

  const send = useCallback(
    async (path: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/admin/${base}/${path}`, {
        method: 'POST',
        headers: me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {},
        body: form,
      });
      return {
        ok: res.ok,
        body: (await res.json().catch(() => ({}))) as {
          total?: number;
          invalid?: number;
          created?: number;
          message?: string;
          rowNumber?: number | null;
          rows?: { rowNumber: number; errors: string[] }[];
        },
      };
    },
    [base, me.csrfToken],
  );

  const onChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // cho chọn lại cùng file
      if (!file) return;
      setBusy(true);
      setResult(null);
      try {
        const pv = await send('preview', file);
        if (!pv.ok) {
          setResult({ ok: false, text: pv.body.message ?? 'Không đọc được file.' });
          return;
        }
        if ((pv.body.invalid ?? 0) > 0) {
          setResult({
            ok: false,
            text: `${pv.body.invalid}/${pv.body.total} dòng lỗi — sửa file rồi Import lại.`,
            errors: (pv.body.rows ?? [])
              .filter((r) => r.errors.length > 0)
              .map((r) => ({ row: r.rowNumber, msgs: r.errors })),
          });
          return;
        }
        // File sạch → nạp ngay.
        const cm = await send('commit', file);
        if (!cm.ok) {
          setResult({
            ok: false,
            text: cm.body.message ?? 'Nạp dữ liệu thất bại.',
            errors: (cm.body.rows ?? [])
              .filter((r) => r.errors.length > 0)
              .map((r) => ({ row: r.rowNumber, msgs: r.errors })),
          });
          return;
        }
        setResult({ ok: true, text: `Đã nạp ${cm.body.created} dòng.` });
        onCommitted?.();
      } catch {
        setResult({ ok: false, text: 'Không kết nối được máy chủ.' });
      } finally {
        setBusy(false);
      }
    },
    [send, onCommitted],
  );

  return { pick, busy, result, inputRef, onChange };
}

/** Hộp chọn file ẩn + vùng báo kết quả/lỗi cho useQuickImport. */
export function QuickImportSlot({
  hook,
}: {
  hook: ReturnType<typeof useQuickImport>;
}) {
  return (
    <>
      <input
        ref={hook.inputRef}
        type="file"
        accept=".xlsx"
        style={{ display: 'none' }}
        onChange={(e) => void hook.onChange(e)}
      />
      {hook.result && (
        <div className={`alert ${hook.result.ok ? 'ok' : 'error'}`}>
          <div>{hook.result.text}</div>
          {hook.result.errors && hook.result.errors.length > 0 && (
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
              {hook.result.errors.slice(0, 30).map((er) => (
                <li key={er.row}>
                  Dòng {er.row}: {er.msgs.join(' ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

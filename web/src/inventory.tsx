import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Me } from './panels';

interface RoundFile {
  id: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
}

interface Round {
  id: string;
  year: number;
  note: string | null;
  createdBy: string;
  createdAt: string;
  files: RoundFile[];
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Màn Kiểm kê hằng năm (story 2.8, FR-39) — Admin/SA. */
export function InventoryPage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const [rounds, setRounds] = useState<Round[]>([]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await fetch('/api/admin/inventory-rounds', { signal });
        if (res.status === 401) {
          window.location.href = '/';
          return;
        }
        if (!res.ok) {
          setError(t('inventory.loadFailed'));
          return;
        }
        setRounds((await res.json()) as Round[]);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError(t('app.serverUnreachable'));
        }
      }
    },
    [t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const createRound = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/inventory-rounds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify({
          year: Number(year),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      if (res.ok) {
        setNote('');
        await load();
      } else {
        const body = (await res.json()) as { message?: string };
        setError(body.message ?? t('inventory.createFailed'));
      }
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [year, note, me.csrfToken, load, t]);

  const uploadFile = useCallback(
    async (roundId: string, file: File) => {
      setBusy(true);
      setError(null);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(
          `/api/admin/inventory-rounds/${encodeURIComponent(roundId)}/files`,
          {
            method: 'POST',
            headers: me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {},
            body: form,
          },
        );
        if (res.ok) {
          await load();
        } else {
          const body = (await res.json()) as { message?: string };
          setError(body.message ?? t('inventory.uploadFailed'));
        }
      } catch {
        setError(t('app.serverUnreachable'));
      } finally {
        setBusy(false);
        const input = fileInputs.current[roundId];
        if (input) input.value = ''; // chọn lại cùng file vẫn trigger change
      }
    },
    [me.csrfToken, load, t],
  );

  const del = useCallback(
    async (url: string, confirmMsg: string) => {
      if (!window.confirm(confirmMsg)) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, {
          method: 'DELETE',
          headers: me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {},
        });
        if (res.ok) {
          await load();
        } else {
          const body = (await res.json().catch(() => ({}))) as {
            message?: string;
          };
          setError(body.message ?? t('inventory.deleteFailed'));
        }
      } catch {
        setError(t('app.serverUnreachable'));
      } finally {
        setBusy(false);
      }
    },
    [me.csrfToken, load, t],
  );

  const fmtDateTime = (v: string) =>
    new Date(v).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN');

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/tai-san">‹ {t('assets.backToList')}</Link>
      </p>
      <div className="page-header">
        <h1>{t('inventory.title')}</h1>
      </div>
      {error && <p className="alert error">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void createRound();
        }}
        style={{
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          marginBottom: '1rem',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column' }}>
          {t('inventory.year')} *
          <input
            type="number"
            required
            min={2000}
            max={2100}
            value={year}
            onChange={(e) => setYear(e.target.value)}
            style={{ width: 100 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', minWidth: 260 }}>
          {t('inventory.noteLabel')}
          <input
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {t('inventory.createRound')}
        </button>
      </form>
      {rounds.length === 0 && <p className="empty">{t('inventory.empty')}</p>}
      {rounds.map((r) => (
        <section
          key={r.id}
          className="card"
          style={{
            padding: '0.75rem 1rem',
            marginBottom: '0.75rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              margin: '0 0 0.25rem',
            }}
          >
            <h2 style={{ fontSize: '1rem', margin: 0 }}>
              {t('inventory.roundTitle', { year: r.year })}
            </h2>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="danger sm"
              disabled={busy}
              onClick={() =>
                void del(
                  `/api/admin/inventory-rounds/${encodeURIComponent(r.id)}`,
                  t('inventory.deleteRoundConfirm', { year: r.year }),
                )
              }
            >
              {t('inventory.deleteRound')}
            </button>
          </div>
          <p style={{ fontSize: '0.85rem', color: '#555', margin: '0 0 0.5rem' }}>
            {fmtDateTime(r.createdAt)}
            {r.note ? ` — ${r.note}` : ''}
          </p>
          {r.files.length === 0 ? (
            <p style={{ fontSize: '0.85rem' }}>{t('inventory.noFiles')}</p>
          ) : (
            <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
              {r.files.map((f) => (
                <li key={f.id}>
                  <a href={`/api/admin/files/${f.id}/download`}>
                    {f.originalName}
                  </a>{' '}
                  <span style={{ color: '#555', fontSize: '0.85rem' }}>
                    ({formatSize(f.sizeBytes)})
                  </span>{' '}
                  <button
                    type="button"
                    className="ghost sm"
                    disabled={busy}
                    title={t('inventory.deleteFile')}
                    onClick={() =>
                      void del(
                        `/api/admin/inventory-rounds/${encodeURIComponent(r.id)}/files/${encodeURIComponent(f.id)}`,
                        t('inventory.deleteFileConfirm', {
                          name: f.originalName,
                        }),
                      )
                    }
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="dropzone" style={{ cursor: busy ? 'default' : 'pointer' }}>
            📎{' '}
            {t('inventory.dropzoneBefore', 'Kéo-thả hoặc ')}
            <b>{t('inventory.dropzonePick', 'chọn tệp')}</b>
            {t('inventory.dropzoneAfter', ' biên bản (pdf / xlsx / ảnh)')}
            <input
              type="file"
              accept=".pdf,.xlsx,.jpg,.jpeg,.png,.webp"
              disabled={busy}
              ref={(el) => {
                fileInputs.current[r.id] = el;
              }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadFile(r.id, file);
              }}
            />
          </label>
        </section>
      ))}
    </>
  );
}

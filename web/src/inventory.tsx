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

  const fmtDateTime = (v: string) =>
    new Date(v).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN');

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/tai-san">‹ {t('assets.backToList')}</Link>
      </p>
      <h1 style={{ fontSize: '1.2rem' }}>{t('inventory.title')}</h1>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
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
        <button type="submit" disabled={busy}>
          {t('inventory.createRound')}
        </button>
      </form>
      {rounds.length === 0 && <p>{t('inventory.empty')}</p>}
      {rounds.map((r) => (
        <section
          key={r.id}
          style={{
            border: '1px solid #ddd',
            borderRadius: 6,
            padding: '0.75rem 1rem',
            marginBottom: '0.75rem',
            maxWidth: 720,
          }}
        >
          <h2 style={{ fontSize: '1rem', margin: '0 0 0.25rem' }}>
            {t('inventory.roundTitle', { year: r.year })}
          </h2>
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
                  </span>
                </li>
              ))}
            </ul>
          )}
          <label style={{ fontSize: '0.9rem' }}>
            {t('inventory.uploadFile')}{' '}
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

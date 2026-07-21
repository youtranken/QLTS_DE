import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from './ui/confirm-provider';
import type { Me } from './me';

interface SessionRow {
  id: string;
  version: number;
  ticketId: string;
  state: string;
  borrowerName: string | null;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  isOverdue: boolean;
}

/** 4.5a — hàng đợi giao/nhận TỪNG buổi của chuỗi định kỳ (route sessions/:id/deliver|return). */
export function RecurringSessionQueue({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const askConfirm = useConfirm();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/tickets/recurring-sessions');
      if (res.ok) setRows((await res.json()) as SessionRow[]);
    } catch {
      setError(t('sessq.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const uploadPhoto = useCallback(
    async (file: File): Promise<string | null> => {
      const fd = new FormData();
      fd.append('kind', 'image');
      fd.append('file', file);
      const res = await fetch('/api/admin/files', {
        method: 'POST',
        headers: me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {},
        body: fd,
      });
      if (!res.ok) return null;
      return ((await res.json()) as { id: string }).id;
    },
    [me.csrfToken],
  );

  const act = useCallback(
    async (row: SessionRow) => {
      const kind = row.state === 'pending' ? 'deliver' : 'return';
      if (kind === 'return' && note.trim() === '') {
        setError(t('sessq.noteRequired'));
        return;
      }
      setBusyId(row.id);
      setError(null);
      try {
        let photoIds: string[] = [];
        if (photo) {
          const fid = await uploadPhoto(photo);
          if (fid) photoIds = [fid];
        }
        const res = await fetch(`/api/admin/tickets/sessions/${row.id}/${kind}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({
            version: row.version,
            note: note.trim() || undefined,
            photoIds,
          }),
        });
        if (res.ok) {
          setActingId(null);
          setNote('');
          setPhoto(null);
          await load();
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        await load();
        setError(
          body.code === 'STALE_VERSION'
            ? t('sessq.errStale')
            : body.code === 'INVALID_STATE'
              ? t('sessq.errInvalidState')
              : t('sessq.error'),
        );
      } catch {
        setError(t('sessq.error'));
      } finally {
        setBusyId(null);
      }
    },
    [note, photo, uploadPhoto, me.csrfToken, load, t],
  );

  const cancel = useCallback(
    async (row: SessionRow) => {
      if (!(await askConfirm({ message: t('sessq.confirmCancel'), danger: true })))
        return;
      setBusyId(row.id);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/tickets/sessions/${row.id}/cancel`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({ version: row.version }),
          },
        );
        await load();
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { code?: string };
          setError(
            body.code === 'STALE_VERSION'
              ? t('sessq.errStale')
              : t('sessq.error'),
          );
        }
      } catch {
        setError(t('sessq.error'));
      } finally {
        setBusyId(null);
      }
    },
    [me.csrfToken, load, t, askConfirm],
  );

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
          timeZone: 'Asia/Ho_Chi_Minh',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div className="page-header">
        <h2>{t('sessq.title')}</h2>
      </div>
      {error && <p className="alert error">{error}</p>}
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {rows.map((row) => {
              const kind = row.state === 'pending' ? 'deliver' : 'return';
              return (
                <tr key={row.id} className={row.isOverdue ? 'overdue' : undefined}>
                  <td>{row.borrowerName ?? '—'}</td>
                  <td>
                    <span className="mono">{row.assetCode ?? '—'}</span>
                  </td>
                  <td>
                    {fmt(row.from)} → {fmt(row.to)}
                  </td>
                  <td>
                    <span
                      className={`badge ${row.state === 'pending' ? 'warn' : 'ok'}`}
                    >
                      {t(`sessq.state_${row.state}`)}
                    </span>
                  </td>
                  <td className="table-actions">
                    {actingId === row.id ? (
                      <span
                        style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                      >
                        <input
                          value={note}
                          placeholder={
                            kind === 'return'
                              ? t('sessq.notePlaceholderRequired')
                              : t('sessq.notePlaceholder')
                          }
                          onChange={(e) => setNote(e.target.value)}
                          style={{ minWidth: 160 }}
                        />
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                        />
                        <button
                          type="button"
                          className="primary sm"
                          disabled={busyId !== null}
                          onClick={() => void act(row)}
                        >
                          {t('sessq.confirm')}
                        </button>
                        <button
                          type="button"
                          className="sm"
                          onClick={() => {
                            setActingId(null);
                            setNote('');
                            setPhoto(null);
                          }}
                        >
                          {t('sessq.cancel')}
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="primary sm"
                          disabled={busyId !== null}
                          onClick={() => {
                            setActingId(row.id);
                            setNote('');
                            setPhoto(null);
                          }}
                        >
                          {kind === 'deliver'
                            ? t('sessq.deliver')
                            : t('sessq.receive')}
                        </button>{' '}
                        {/* 4.6: hủy buổi CHƯA giao (pending) — buổi đã giao đi luồng nhận */}
                        {row.state === 'pending' && (
                          <button
                            type="button"
                            className="danger sm"
                            disabled={busyId !== null}
                            onClick={() => void cancel(row)}
                          >
                            {t('sessq.cancelSession')}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

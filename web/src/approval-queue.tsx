import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

interface PendingRequest {
  id: string;
  version: number;
  borrowerSub: string;
  borrowerName: string | null;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  createdAt: string;
}

/** Hàng đợi Admin duyệt/từ chối request >48h (3.4). */
export function ApprovalQueuePage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<PendingRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/tickets/pending-approval');
      if (res.ok) {
        setItems((await res.json()) as PendingRequest[]);
        return;
      }
      setError(t('approval.error'));
    } catch {
      setError(t('approval.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (
      req: PendingRequest,
      kind: 'approve' | 'reject',
      rejectReason?: string,
    ) => {
      setBusyId(req.id);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/tickets/${req.id}/${kind}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify(
              kind === 'reject'
                ? { version: req.version, reason: rejectReason }
                : { version: req.version },
            ),
          },
        );
        if (res.ok) {
          setRejectingId(null);
          setReason('');
          await load();
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        const map: Record<string, string> = {
          STALE_VERSION: t('approval.errStale'),
          INVALID_STATE: t('approval.errInvalidState'),
          PICKUP_PASSED: t('approval.errPickupPassed'),
        };
        // load() reset error=null → phải reload TRƯỚC rồi mới set message (không bị nuốt)
        await load();
        setError((body.code && map[body.code]) || t('approval.error'));
      } catch {
        setError(t('approval.error'));
      } finally {
        setBusyId(null);
      }
    },
    [me.csrfToken, load, t],
  );

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(
          i18n.language === 'vi' ? 'vi-VN' : 'en-US',
          {
            timeZone: 'Asia/Ho_Chi_Minh',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          },
        )
      : '—';

  return (
    <section style={{ maxWidth: 950 }}>
      <h1 style={{ fontSize: '1.2rem', marginBottom: '1rem' }}>
        {t('approval.title')}
      </h1>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {items === null && <p>{t('approval.loading')}</p>}
      {items !== null && items.length === 0 && <p>{t('approval.empty')}</p>}
      {items !== null && items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {['colBorrower', 'colMachine', 'colTime'].map((k) => (
                  <th
                    key={k}
                    style={{
                      textAlign: 'left',
                      borderBottom: '1px solid #ccc',
                      padding: '0.4rem',
                    }}
                  >
                    {t(`approval.${k}`)}
                  </th>
                ))}
                <th style={{ borderBottom: '1px solid #ccc' }} />
              </tr>
            </thead>
            <tbody>
              {items.map((req) => (
                <tr key={req.id}>
                  <td style={{ padding: '0.4rem' }}>
                    {req.borrowerName ?? req.borrowerSub}
                  </td>
                  <td style={{ padding: '0.4rem' }}>{req.assetCode ?? '—'}</td>
                  <td style={{ padding: '0.4rem' }}>
                    {fmt(req.from)} → {fmt(req.to)}
                  </td>
                  <td style={{ padding: '0.4rem', whiteSpace: 'nowrap' }}>
                    {rejectingId === req.id ? (
                      <span
                        style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                      >
                        <input
                          value={reason}
                          placeholder={t('approval.reasonPlaceholder')}
                          onChange={(e) => setReason(e.target.value)}
                          style={{ minWidth: 180 }}
                        />
                        <button
                          type="button"
                          disabled={busyId !== null || reason.trim() === ''}
                          onClick={() => void act(req, 'reject', reason.trim())}
                        >
                          {t('approval.confirmReject')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingId(null);
                            setReason('');
                          }}
                        >
                          {t('approval.cancel')}
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void act(req, 'approve')}
                        >
                          {t('approval.approve')}
                        </button>{' '}
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => {
                            setRejectingId(req.id);
                            setReason('');
                          }}
                        >
                          {t('approval.reject')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <HandoverQueues me={me} />
    </section>
  );
}

interface QueueRow {
  id: string;
  version: number;
  borrowerName: string | null;
  assetCode: string | null;
  from: string | null;
  to: string | null;
}

/** Hàng đợi chờ giao (Đã giao) + đang mượn (Đã nhận) — story 3.6. */
function HandoverQueues({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const [pickup, setPickup] = useState<QueueRow[]>([]);
  const [inUse, setInUse] = useState<QueueRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, b] = await Promise.all([
        fetch('/api/admin/tickets/awaiting-pickup'),
        fetch('/api/admin/tickets/in-use'),
      ]);
      if (a.ok) setPickup((await a.json()) as QueueRow[]);
      if (b.ok) setInUse((await b.json()) as QueueRow[]);
    } catch {
      setError(t('handover.error'));
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
    async (row: QueueRow, kind: 'deliver' | 'return') => {
      if (kind === 'return' && note.trim() === '') {
        setError(t('handover.noteRequired'));
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
        const res = await fetch(`/api/admin/tickets/${row.id}/${kind}`, {
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
            ? t('handover.errStale')
            : body.code === 'INVALID_STATE'
              ? t('handover.errInvalidState')
              : t('handover.error'),
        );
      } catch {
        setError(t('handover.error'));
      } finally {
        setBusyId(null);
      }
    },
    [note, photo, uploadPhoto, me.csrfToken, load, t],
  );

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(
          i18n.language === 'vi' ? 'vi-VN' : 'en-US',
          {
            timeZone: 'Asia/Ho_Chi_Minh',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          },
        )
      : '—';

  const renderQueue = (
    rows: QueueRow[],
    kind: 'deliver' | 'return',
    titleKey: string,
    actionKey: string,
  ) => (
    <div style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1.05rem', marginBottom: '0.5rem' }}>
        {t(titleKey)}
      </h2>
      {rows.length === 0 ? (
        <p>{t('handover.empty')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={{ padding: '0.4rem' }}>
                    {row.borrowerName ?? '—'}
                  </td>
                  <td style={{ padding: '0.4rem' }}>{row.assetCode ?? '—'}</td>
                  <td style={{ padding: '0.4rem' }}>
                    {fmt(row.from)} → {fmt(row.to)}
                  </td>
                  <td style={{ padding: '0.4rem', whiteSpace: 'nowrap' }}>
                    {actingId === row.id ? (
                      <span
                        style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                      >
                        <input
                          value={note}
                          placeholder={
                            kind === 'return'
                              ? t('handover.notePlaceholderRequired')
                              : t('handover.notePlaceholder')
                          }
                          onChange={(e) => setNote(e.target.value)}
                          style={{ minWidth: 160 }}
                        />
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) =>
                            setPhoto(e.target.files?.[0] ?? null)
                          }
                        />
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void act(row, kind)}
                        >
                          {t('handover.confirm')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setActingId(null);
                            setNote('');
                            setPhoto(null);
                          }}
                        >
                          {t('handover.cancel')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => {
                          setActingId(row.id);
                          setNote('');
                          setPhoto(null);
                        }}
                      >
                        {t(actionKey)}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {renderQueue(pickup, 'deliver', 'handover.pickupTitle', 'handover.deliver')}
      {renderQueue(inUse, 'return', 'handover.inUseTitle', 'handover.receive')}
    </div>
  );
}

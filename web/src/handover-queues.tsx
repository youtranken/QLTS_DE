import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ForceCancelButton } from '@/force-cancel-button';
import type { Me } from '@/lib/me';

interface QueueRow {
  id: string;
  version: number;
  borrowerName: string | null;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  isOverdue?: boolean;
  overdueMinutes?: number | null;
}

/** Hàng đợi chờ giao (Đã giao) + đang mượn (Đã nhận) — story 3.6. */
export function HandoverQueues({
  me,
  onCounts,
}: {
  me: Me;
  onCounts?: (c: { pickup: number; inUse: number; overdue: number }) => void;
}) {
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

  useEffect(() => {
    onCounts?.({
      pickup: pickup.length,
      inUse: inUse.length,
      overdue: inUse.filter((r) => r.isOverdue).length,
    });
  }, [pickup, inUse, onCounts]);

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

  const locale = i18n.language === 'vi' ? 'vi-VN' : 'en-US';
  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(locale, {
          timeZone: 'Asia/Ho_Chi_Minh',
          day: '2-digit',
          month: '2-digit',
        })
      : '—';
  const fmtTime = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleTimeString(locale, {
          timeZone: 'Asia/Ho_Chi_Minh',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  const renderQueue = (
    rows: QueueRow[],
    kind: 'deliver' | 'return',
    titleKey: string,
    actionKey: string,
  ) => (
    <div style={{ marginTop: '1.5rem' }}>
      <div className="page-header">
        <h2>{t(titleKey)}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{t('handover.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('handover.colBorrower', 'Người mượn')}</th>
                <th>{t('handover.colAsset', 'Thiết bị')}</th>
                <th>{t('handover.colPickDate', 'Ngày nhận')}</th>
                <th>{t('handover.colPickTime', 'Giờ nhận')}</th>
                <th>{t('handover.colDueDate', 'Ngày trả')}</th>
                <th>{t('handover.colDueTime', 'Giờ trả')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.isOverdue ? 'overdue' : undefined}>
                  <td>
                    {row.borrowerName ?? '—'}
                    {/* F8: badge đỏ + thời lượng quá hạn NGAY trên queue đang mượn (3.8/3.12
                        AC "đỏ, sort" — backend listQueue sort is_overdue lên đầu) */}
                    {row.isOverdue && (
                      <span
                        style={{
                          marginLeft: 6,
                          padding: '1px 6px',
                          borderRadius: 3,
                          background: '#c0392b',
                          color: '#fff',
                          fontSize: '0.75rem',
                        }}
                      >
                        {t('myreq.overdue', {
                          h: Math.floor((row.overdueMinutes ?? 0) / 60),
                          m: (row.overdueMinutes ?? 0) % 60,
                        })}
                      </span>
                    )}
                  </td>
                  <td>
                    {row.assetCode ? (
                      <span className="mono">{row.assetCode}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{fmtDate(row.from)}</td>
                  <td className="mono">{fmtTime(row.from)}</td>
                  <td>{fmtDate(row.to)}</td>
                  <td className="mono">{fmtTime(row.to)}</td>
                  <td className="table-actions">
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
                          className="primary sm"
                          disabled={busyId !== null}
                          onClick={() => void act(row, kind)}
                        >
                          {t('handover.confirm')}
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
                          {t('handover.cancel')}
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
                          {t(actionKey)}
                        </button>{' '}
                        {/* Hủy cưỡng chế CHỈ ở hàng chờ giao (awaiting_pickup, kind=deliver) —
                            máy đang mượn (in_use, kind=return) phải đi đường Trả (review M1). */}
                        {kind === 'deliver' && (
                          <ForceCancelButton
                            ticketId={row.id}
                            me={me}
                            disabled={busyId !== null}
                            onDone={() => void load()}
                          />
                        )}
                      </>
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
      {error && <p className="alert error">{error}</p>}
      {renderQueue(pickup, 'deliver', 'handover.pickupTitle', 'handover.deliver')}
      {renderQueue(inUse, 'return', 'handover.inUseTitle', 'handover.receive')}
    </div>
  );
}

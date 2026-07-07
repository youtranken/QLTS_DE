import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CreateForForm } from './create-for';
import type { Me } from './panels';
import { RecurringSessionQueue } from './recurring-session-queue';

interface PendingRequest {
  id: string;
  version: number;
  kind: string;
  borrowerSub: string;
  borrowerName: string | null;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  sessionCount: number;
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
        // 4.5a: chuỗi định kỳ duyệt/từ chối CẢ chuỗi qua route recurring/*
        const path =
          req.kind === 'recurring'
            ? `/api/admin/tickets/recurring/${req.id}/${kind}`
            : `/api/admin/tickets/${req.id}/${kind}`;
        const res = await fetch(
          path,
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
    <section>
      <div className="page-header">
        <h1>{t('approval.title')}</h1>
      </div>
      {error && <p className="alert error">{error}</p>}
      {items === null && <p>{t('approval.loading')}</p>}
      {items !== null && items.length === 0 && (
        <p className="empty">{t('approval.empty')}</p>
      )}
      {items !== null && items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['colBorrower', 'colMachine', 'colTime'].map((k) => (
                  <th key={k}>{t(`approval.${k}`)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((req) => (
                <tr key={req.id}>
                  <td>{req.borrowerName ?? req.borrowerSub}</td>
                  <td>
                    {req.assetCode ? (
                      <span className="mono">{req.assetCode}</span>
                    ) : (
                      '—'
                    )}
                    {req.kind === 'recurring' && (
                      <span className="badge muted" style={{ marginLeft: 6 }}>
                        {t('approval.recurringChip', { n: req.sessionCount })}
                      </span>
                    )}
                  </td>
                  <td>
                    {fmt(req.from)} → {fmt(req.to)}
                    {req.kind === 'recurring' && (
                      <span className="muted"> {t('approval.recurringFirst')}</span>
                    )}
                  </td>
                  <td className="table-actions">
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
                          className="danger sm"
                          disabled={busyId !== null || reason.trim() === ''}
                          onClick={() => void act(req, 'reject', reason.trim())}
                        >
                          {t('approval.confirmReject')}
                        </button>
                        <button
                          type="button"
                          className="sm"
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
                          className="primary sm"
                          disabled={busyId !== null}
                          onClick={() => void act(req, 'approve')}
                        >
                          {t('approval.approve')}
                        </button>{' '}
                        <button
                          type="button"
                          className="danger sm"
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

      <ExtensionQueue me={me} />
      <HandoverQueues me={me} />
      <RecurringSessionQueue me={me} />
      <CreateForForm me={me} />
    </section>
  );
}

interface ExtensionRow {
  extensionId: string;
  version: number;
  borrowerName: string | null;
  assetCode: string | null;
  oldDue: string | null;
  newDue: string | null;
  usedCount: number;
}

/** Hàng đợi Chờ gia hạn (4.2) — duyệt/từ chối, đọc kết cục qua result (AD-16). */
function ExtensionQueue({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<ExtensionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/tickets/extensions');
      if (res.ok) setRows((await res.json()) as ExtensionRow[]);
    } catch {
      setError(t('extapprove.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (row: ExtensionRow, kind: 'approve' | 'reject', rej?: string) => {
      setBusyId(row.extensionId);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/tickets/extensions/${row.extensionId}/${kind}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify(
              kind === 'reject'
                ? { version: row.version, reason: rej }
                : { version: row.version },
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
          STALE_VERSION: t('extapprove.errStale'),
          EXTENSION_EXPIRED: t('extapprove.errExpired'),
          INVALID_STATE: t('extapprove.errState'),
        };
        await load();
        setError((body.code && map[body.code]) || t('extapprove.error'));
      } catch {
        setError(t('extapprove.error'));
      } finally {
        setBusyId(null);
      }
    },
    [me.csrfToken, load, t],
  );

  const fmt = (isoStr: string | null) =>
    isoStr
      ? new Date(isoStr).toLocaleString(
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

  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1.05rem', marginBottom: '0.5rem' }}>
        {t('extapprove.title')}
      </h2>
      {error && <p className="alert error">{error}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('extapprove.colBorrower')}</th>
              <th>{t('extapprove.colMachine')}</th>
              <th>{t('extapprove.colDue')}</th>
              <th>{t('extapprove.colUsed')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.extensionId}>
                <td>{row.borrowerName ?? '—'}</td>
                <td>
                  <span className="mono">{row.assetCode ?? '—'}</span>
                </td>
                <td>
                  {fmt(row.oldDue)} → {fmt(row.newDue)}
                </td>
                <td>{row.usedCount}</td>
                <td className="table-actions">
                  {rejectingId === row.extensionId ? (
                    <span
                      style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                    >
                      <input
                        value={reason}
                        placeholder={t('extapprove.reasonPlaceholder')}
                        onChange={(e) => setReason(e.target.value)}
                        style={{ minWidth: 160 }}
                      />
                      <button
                        type="button"
                        className="danger sm"
                        disabled={busyId !== null || reason.trim() === ''}
                        onClick={() => void act(row, 'reject', reason.trim())}
                      >
                        {t('extapprove.confirmReject')}
                      </button>
                      <button
                        type="button"
                        className="sm"
                        onClick={() => {
                          setRejectingId(null);
                          setReason('');
                        }}
                      >
                        {t('extapprove.cancel')}
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="primary sm"
                        disabled={busyId !== null}
                        onClick={() => void act(row, 'approve')}
                      >
                        {t('extapprove.approve')}
                      </button>{' '}
                      <button
                        type="button"
                        className="danger sm"
                        disabled={busyId !== null}
                        onClick={() => {
                          setRejectingId(row.extensionId);
                          setReason('');
                        }}
                      >
                        {t('extapprove.reject')}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
      <div className="page-header">
        <h2>{t(titleKey)}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{t('handover.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
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
                  <td>
                    {fmt(row.from)} → {fmt(row.to)}
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
      {error && <p className="alert error">{error}</p>}
      {renderQueue(pickup, 'deliver', 'handover.pickupTitle', 'handover.deliver')}
      {renderQueue(inUse, 'return', 'handover.inUseTitle', 'handover.receive')}
    </div>
  );
}

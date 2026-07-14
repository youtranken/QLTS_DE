import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';
import type { FreeMachine, SessionRow } from './booking-types';

/** Admin đặt định kỳ hộ (7.5) — builder buổi + máy (theo buổi đầu) → recurring-for. */
export function RecurringAdminBuilder({
  me,
  borrowerSub,
  onBooked,
}: {
  me: Me;
  borrowerSub: string;
  onBooked: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionRow[]>([{ from: '', to: '' }]);
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setRow = (i: number, patch: Partial<SessionRow>) =>
    setSessions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const valid =
    sessions.length > 0 && sessions.every((s) => s.from && s.to && s.to > s.from);

  const findMachines = useCallback(async () => {
    const s0 = sessions[0];
    if (!s0?.from || !s0?.to) return;
    setAssetId(''); // đổi buổi → bỏ máy đã chọn (chống stale)
    try {
      const res = await fetch(
        `/api/booking/availability?from=${encodeURIComponent(new Date(s0.from).toISOString())}&to=${encodeURIComponent(new Date(s0.to).toISOString())}`,
      );
      if (res.ok) setMachines((await res.json()) as FreeMachine[]);
    } catch {
      /* ignore */
    }
  }, [sessions]);

  const submit = useCallback(async () => {
    setMsg(null);
    if (!borrowerSub) {
      setMsg({ ok: false, text: t('bookingSheet.errNoBorrower') });
      return;
    }
    if (!assetId || !valid) {
      setMsg({ ok: false, text: t('bookingSheet.errMissing') });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/tickets/recurring-for', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify({
          borrowerSub,
          assetId,
          sessions: sessions.map((s) => ({
            from: new Date(s.from).toISOString(),
            to: new Date(s.to).toISOString(),
          })),
        }),
      });
      if (res.status === 201) {
        onBooked();
        return;
      }
      const b = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg({ ok: false, text: b.message ?? t('booking.errGeneric') });
    } catch {
      setMsg({ ok: false, text: t('booking.errGeneric') });
    } finally {
      setBusy(false);
    }
  }, [borrowerSub, assetId, valid, sessions, me.csrfToken, onBooked, t]);

  return (
    <div className="form-section">
      <div className="form-section-title">{t('bookingSheet.recurringSessions')}</div>
      {sessions.map((s, i) => (
        <div key={i} className="form-grid" style={{ marginBottom: '0.5rem' }}>
          <label className="field">
            <span>{t('booking.from')}</span>
            <input
              type="datetime-local"
              value={s.from}
              onChange={(e) => setRow(i, { from: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('booking.to')}</span>
            <input
              type="datetime-local"
              value={s.to}
              onChange={(e) => setRow(i, { to: e.target.value })}
            />
          </label>
          {sessions.length > 1 && (
            <button
              type="button"
              className="sm"
              onClick={() =>
                setSessions((rows) => rows.filter((_, j) => j !== i))
              }
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, margin: '0.5rem 0' }}>
        <button
          type="button"
          className="sm"
          disabled={sessions.length >= 30}
          onClick={() => setSessions((r) => [...r, { from: '', to: '' }])}
        >
          {t('bookingSheet.addSession')}
        </button>
        <button
          type="button"
          className="sm"
          disabled={!valid}
          onClick={() => void findMachines()}
        >
          {t('bookingSheet.findMachine')}
        </button>
      </div>
      {machines !== null && (
        <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          <option value="">{t('bookingSheet.pickMachine')}</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code} — {m.type}
            </option>
          ))}
        </select>
      )}
      {msg && <p className={`alert ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}
      <div style={{ marginTop: '0.75rem' }}>
        <button
          type="button"
          className="primary"
          disabled={busy || !assetId}
          onClick={() => void submit()}
        >
          {t('bookingSheet.submit')}
        </button>
      </div>
    </div>
  );
}

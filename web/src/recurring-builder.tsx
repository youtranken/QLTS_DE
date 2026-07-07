import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

interface FreeMachine {
  id: string;
  code: string;
  configuration: string | null;
}
interface SessionRow {
  from: string;
  to: string;
}

/** Đặt chuỗi định kỳ (4.4, EXPERIENCE.md P3) — list-builder buổi + 1 máy, all-or-nothing. */
export function RecurringBuilder({
  me,
  onDone,
}: {
  me: Me;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionRow[]>([{ from: '', to: '' }]);
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [stuck, setStuck] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const setRow = (i: number, patch: Partial<SessionRow>) =>
    setSessions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () =>
    setSessions((rows) => [...rows, { from: '', to: '' }]);
  const removeRow = (i: number) =>
    setSessions((rows) => rows.filter((_, j) => j !== i));

  const valid = sessions.every((s) => s.from && s.to && s.to > s.from);

  // Tìm máy rảnh cho BUỔI ĐẦU (member chọn 1 máy cho cả chuỗi).
  const findMachines = useCallback(async () => {
    setMsg(null);
    setStuck(null);
    const first = sessions[0];
    if (!first?.from || !first?.to) return;
    try {
      const res = await fetch(
        `/api/booking/availability?from=${encodeURIComponent(
          new Date(first.from).toISOString(),
        )}&to=${encodeURIComponent(new Date(first.to).toISOString())}`,
      );
      if (res.ok) {
        setMachines((await res.json()) as FreeMachine[]);
      } else {
        setMsg({ ok: false, text: t('recur.errFind') });
      }
    } catch {
      setMsg({ ok: false, text: t('recur.errFind') });
    }
  }, [sessions, t]);

  const submit = useCallback(async () => {
    setMsg(null);
    setStuck(null);
    if (!assetId || !valid) {
      setMsg({ ok: false, text: t('recur.errMissing') });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/booking/recurring', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify({
          assetId,
          sessions: sessions.map((s) => ({
            from: new Date(s.from).toISOString(),
            to: new Date(s.to).toISOString(),
          })),
        }),
      });
      if (res.status === 201 || res.ok) {
        setMsg({ ok: true, text: t('recur.ok') });
        setSessions([{ from: '', to: '' }]);
        setMachines(null);
        setAssetId('');
        onDone();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        stuckSession?: number;
      };
      const map: Record<string, string> = {
        SLOT_TAKEN: t('recur.errSlot'),
        ASSET_UNAVAILABLE: t('recur.errAsset'),
        RECUR_WEEK_DUP: t('recur.errWeek'),
        RECUR_SPAN: t('recur.errSpan'),
        BOOKING_WINDOW: t('recur.errWindow'),
        INVALID_RANGE: t('recur.errRange'),
        QUOTA_EXCEEDED: t('recur.errQuota'),
        RECUR_NOT_ALLOWED: t('recur.errAllowed'),
      };
      if (typeof body.stuckSession === 'number') setStuck(body.stuckSession);
      // Khung bị nẫng → refetch máy buổi đầu (convention 409 refetch)
      if (body.code === 'SLOT_TAKEN') await findMachines();
      setMsg({ ok: false, text: (body.code && map[body.code]) || t('recur.errGeneric') });
    } catch {
      setMsg({ ok: false, text: t('recur.errGeneric') });
    } finally {
      setBusy(false);
    }
  }, [assetId, valid, sessions, me.csrfToken, onDone, findMachines, t]);

  return (
    <details className="section-gap">
      <summary style={{ cursor: 'pointer', fontSize: '1.05rem' }}>
        {t('recur.title')}
      </summary>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          marginTop: 10,
          maxWidth: 620,
        }}
      >
        {sessions.map((s, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
              padding: 8,
              borderRadius: 8,
              border: `1px solid ${
                stuck === i ? 'var(--danger)' : 'var(--border)'
              }`,
              background: stuck === i ? 'var(--danger-soft)' : 'transparent',
            }}
          >
            <label className="field">
              {t('recur.from')} {i + 1}
              <input
                type="datetime-local"
                value={s.from}
                onChange={(e) => setRow(i, { from: e.target.value })}
              />
            </label>
            <label className="field">
              {t('recur.to')}
              <input
                type="datetime-local"
                value={s.to}
                onChange={(e) => setRow(i, { to: e.target.value })}
              />
            </label>
            {sessions.length > 1 && (
              <button
                type="button"
                className="ghost sm"
                onClick={() => removeRow(i)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="sm" onClick={addRow}>
            {t('recur.addSession')}
          </button>
          <button
            type="button"
            className="sm"
            disabled={!valid}
            onClick={() => void findMachines()}
          >
            {t('recur.findMachine')}
          </button>
        </div>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          {t('recur.preview', { n: sessions.length })}
        </p>
        {machines !== null && (
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">{t('recur.pickMachine')}</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} {m.configuration ? `— ${m.configuration}` : ''}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="primary"
          disabled={busy || !assetId || !valid}
          onClick={() => void submit()}
        >
          {busy ? t('recur.submitting') : t('recur.submit')}
        </button>
        {msg && (
          <p className={`alert ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>
        )}
      </div>
    </details>
  );
}

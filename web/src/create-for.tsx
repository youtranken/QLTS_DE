import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';

interface FreeMachine {
  id: string;
  code: string;
  configuration: string | null;
}

/** Admin tạo request hộ member (3.7) — giao ngay / đặt lịch. */
export function CreateForForm({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [borrowerSub, setBorrowerSub] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [mode, setMode] = useState<'now' | 'schedule'>('schedule');
  const [note, setNote] = useState('');
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const findMachines = useCallback(async () => {
    setMsg(null);
    if (!from || !to) return;
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    try {
      const res = await fetch(
        `/api/booking/availability?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      );
      if (res.ok) {
        setMachines((await res.json()) as FreeMachine[]);
      } else {
        setMsg({ ok: false, text: t('createfor.errFind') });
      }
    } catch {
      setMsg({ ok: false, text: t('createfor.errFind') });
    }
  }, [from, to, t]);

  const submit = useCallback(async () => {
    setMsg(null);
    if (!borrowerSub || !assetId || !from || !to) {
      setMsg({ ok: false, text: t('createfor.errMissing') });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/tickets/create-for', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify({
          borrowerSub,
          assetId,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          mode,
          note: note.trim() || undefined,
        }),
      });
      if (res.status === 201) {
        setMsg({ ok: true, text: t('createfor.ok') });
        setAssetId('');
        setMachines(null);
        setNote('');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      const map: Record<string, string> = {
        SLOT_TAKEN: t('createfor.errSlot'),
        ASSET_UNAVAILABLE: t('createfor.errAsset'),
        USER_NOT_FOUND: t('createfor.errUser'),
        BORROWER_NOT_MEMBER: t('createfor.errNotMember'),
        INVALID_RANGE: t('createfor.errRange'),
        PAST_PICKUP: t('createfor.errRange'),
        BOOKING_WINDOW: t('createfor.errRange'),
        SELF_CREATE_FORBIDDEN: t('createfor.errSelf'),
      };
      setMsg({
        ok: false,
        text: (body.code && map[body.code]) || t('createfor.errGeneric'),
      });
    } catch {
      setMsg({ ok: false, text: t('createfor.errGeneric') });
    } finally {
      setBusy(false);
    }
  }, [borrowerSub, assetId, from, to, mode, note, me.csrfToken, t]);

  return (
    <details style={{ marginTop: '2rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '1.05rem' }}>
        {t('createfor.title')}
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, maxWidth: 520 }}>
        <label>
          {t('createfor.borrower')}
          <input
            value={borrowerSub}
            onChange={(e) => setBorrowerSub(e.target.value)}
            placeholder="sub (PMH ID)"
            style={{ marginLeft: 8, minWidth: 240 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <label>
            {t('createfor.from')}
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            {t('createfor.to')}
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <div>
          <label style={{ marginRight: 12 }}>
            <input
              type="radio"
              checked={mode === 'schedule'}
              onChange={() => setMode('schedule')}
            />{' '}
            {t('createfor.modeSchedule')}
          </label>
          <label>
            <input
              type="radio"
              checked={mode === 'now'}
              onChange={() => setMode('now')}
            />{' '}
            {t('createfor.modeNow')}
          </label>
        </div>
        <button type="button" onClick={() => void findMachines()}>
          {t('createfor.find')}
        </button>
        {machines !== null && (
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">{t('createfor.pickMachine')}</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} {m.configuration ? `— ${m.configuration}` : ''}
              </option>
            ))}
          </select>
        )}
        {mode === 'now' && (
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('createfor.notePlaceholder')}
            rows={2}
          />
        )}
        <button type="button" disabled={busy} onClick={() => void submit()}>
          {t('createfor.submit')}
        </button>
        {msg && (
          <p style={{ color: msg.ok ? '#1a7f37' : '#c0392b' }}>{msg.text}</p>
        )}
      </div>
    </details>
  );
}

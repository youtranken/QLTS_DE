import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RecurringSessionPicker } from '@/features/booking/recurring-session-picker';
import { Select } from '@/ui/select';
import type { Me } from '@/lib/me';
import {
  DEFAULT_WORK_HOURS,
  type FreeMachine,
  type SessionRow,
} from '@/features/booking/booking-types';

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
  const [weekday, setWeekday] = useState<number | ''>('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const workingHours = me.workingHours ?? DEFAULT_WORK_HOURS;

  const valid =
    sessions.length > 0 && sessions.every((s) => s.from && s.to && s.to > s.from);

  // Tự tìm máy rảnh cho buổi đầu khi chuỗi đổi (thứ/giờ) — không cần bấm nút.
  const loadMachines = useCallback(
    async (signal?: AbortSignal) => {
      const s0 = sessions[0];
      if (!s0?.from || !s0?.to || !(s0.to > s0.from)) {
        setMachines(null);
        setAssetId('');
        return;
      }
      try {
        const res = await fetch(
          `/api/booking/availability?from=${encodeURIComponent(new Date(s0.from).toISOString())}&to=${encodeURIComponent(new Date(s0.to).toISOString())}`,
          signal ? { signal } : {},
        );
        const list = res.ok ? ((await res.json()) as FreeMachine[]) : [];
        setMachines(list);
        setAssetId((cur) => (list.some((m) => m.id === cur) ? cur : ''));
      } catch {
        /* abort/mạng — bỏ qua */
      }
    },
    [sessions],
  );

  useEffect(() => {
    const c = new AbortController();
    const timer = setTimeout(() => void loadMachines(c.signal), 250);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [loadMachines]);

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
      <RecurringSessionPicker
        workingHours={workingHours}
        weekday={weekday}
        onWeekday={setWeekday}
        sessions={sessions}
        onChange={setSessions}
        stuck={null}
      />
      {machines !== null && (
        <Select
          value={assetId}
          onChange={setAssetId}
          options={machines.map((m) => ({
            value: m.id,
            label: `${m.code} — ${m.type}`,
          }))}
          placeholder={t('bookingSheet.pickMachine')}
          ariaLabel={t('bookingSheet.pickMachine')}
        />
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

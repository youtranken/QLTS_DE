import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RecurringSessionPicker } from '@/features/booking/recurring-session-picker';
import { Select } from '@/ui/select';
import { DEFAULT_WORK_HOURS } from '@/features/booking/booking-types';
import type { SessionRow } from '@/features/booking/booking-types';
import type { Me } from '@/lib/me';

interface FreeMachine {
  id: string;
  code: string;
  configuration: string | null;
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
  const [weekday, setWeekday] = useState<number | ''>('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [stuck, setStuck] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const workingHours = me.workingHours ?? DEFAULT_WORK_HOURS;

  const valid =
    sessions.length > 0 && sessions.every((s) => s.from && s.to && s.to > s.from);

  // Tự tìm máy rảnh cho BUỔI ĐẦU (member chọn 1 máy cho cả chuỗi) — không cần bấm nút.
  const loadMachines = useCallback(
    async (signal?: AbortSignal) => {
      const first = sessions[0];
      if (!first?.from || !first?.to || !(first.to > first.from)) {
        setMachines(null);
        setAssetId('');
        return;
      }
      try {
        const res = await fetch(
          `/api/booking/availability?from=${encodeURIComponent(
            new Date(first.from).toISOString(),
          )}&to=${encodeURIComponent(new Date(first.to).toISOString())}`,
          signal ? { signal } : {},
        );
        const list = res.ok ? ((await res.json()) as FreeMachine[]) : [];
        setMachines(list);
        // Bỏ máy đã chọn nếu không còn rảnh cho chuỗi mới (chống submit máy stale).
        setAssetId((cur) => (list.some((m) => m.id === cur) ? cur : ''));
      } catch {
        /* abort/mạng — bỏ qua */
      }
    },
    [sessions],
  );

  // Chuỗi đổi (thứ/giờ) → tự nạp lại máy rảnh (debounce nhẹ).
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
        setSessions([]);
        setWeekday('');
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
      if (body.code === 'SLOT_TAKEN') await loadMachines();
      setMsg({ ok: false, text: (body.code && map[body.code]) || t('recur.errGeneric') });
    } catch {
      setMsg({ ok: false, text: t('recur.errGeneric') });
    } finally {
      setBusy(false);
    }
  }, [assetId, valid, sessions, me.csrfToken, onDone, loadMachines, t]);

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
        <RecurringSessionPicker
          workingHours={workingHours}
          weekday={weekday}
          onWeekday={setWeekday}
          sessions={sessions}
          onChange={setSessions}
          stuck={stuck}
        />
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          {t('recur.preview', { n: sessions.length })}
        </p>
        {machines !== null && (
          <Select
            value={assetId}
            onChange={setAssetId}
            options={machines.map((m) => ({
              value: m.id,
              label: `${m.code}${m.configuration ? ` — ${m.configuration}` : ''}`,
            }))}
            placeholder={t('recur.pickMachine')}
            ariaLabel={t('recur.pickMachine')}
          />
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

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from '@/lib/me';

interface WorkingHours {
  tz: string;
  days: number[];
  start: string;
  end: string;
}
interface ConfigShape {
  booking_window_days: number;
  active_ticket_quota: number;
  extension_days_per_grant: number;
  extension_max_grants: number;
  license_warning_days: number;
  approval_reminder_working_hours: number;
  auto_approve_max_hours: number;
  working_hours: WorkingHours;
}

const NUM_KEYS: Array<keyof ConfigShape> = [
  'booking_window_days',
  'active_ticket_quota',
  'extension_days_per_grant',
  'extension_max_grants',
  'license_warning_days',
  'approval_reminder_working_hours',
  'auto_approve_max_hours',
];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** Cấu hình tham số hệ thống (6.3, chỉ SA) — sửa 7 tham số FR-44, hiệu lực ngay. */
export function ConfigPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<ConfigShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/config');
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      if (res.ok) setCfg((await res.json()) as ConfigShape);
      else setError(t('config.loadFailed'));
    } catch {
      setError(t('app.serverUnreachable'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const setNum = (k: keyof ConfigShape) => (v: string) =>
    setCfg((c) => (c ? { ...c, [k]: v === '' ? 0 : Number(v) } : c));
  const setWh = (patch: Partial<WorkingHours>) =>
    setCfg((c) =>
      c ? { ...c, working_hours: { ...c.working_hours, ...patch } } : c,
    );
  const toggleDay = (d: number) =>
    setCfg((c) => {
      if (!c) return c;
      const days = c.working_hours.days.includes(d)
        ? c.working_hours.days.filter((x) => x !== d)
        : [...c.working_hours.days, d].sort((a, b) => a - b);
      return { ...c, working_hours: { ...c.working_hours, days } };
    });

  const save = useCallback(async () => {
    if (!cfg) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify(cfg),
      });
      if (res.ok) {
        setCfg((await res.json()) as ConfigShape);
        setSaved(true);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? t('config.saveFailed'));
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [cfg, me.csrfToken, t]);

  if (!cfg) {
    return (
      <section>
        <div className="page-header">
          <h1>{t('config.title')}</h1>
        </div>
        {error ? <p className="alert error">{error}</p> : <p className="muted">…</p>}
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>{t('config.title')}</h1>
      </div>
      {error && <p className="alert error">{error}</p>}
      {saved && <p className="alert ok">{t('config.saved')}</p>}

      <div className="form-section" style={{ maxWidth: 560, marginInline: 'auto' }}>
        <div className="form-section-title">{t('config.params')}</div>
        <div className="form-grid">
          {NUM_KEYS.map((k) => (
            <label className="field" key={k}>
              <span>{t(`config.${k}`)}</span>
              <input
                type="number"
                min={0}
                value={String(cfg[k] as number)}
                onChange={(e) => setNum(k)(e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="form-section" style={{ maxWidth: 560, marginInline: 'auto' }}>
        <div className="form-section-title">{t('config.working_hours')}</div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <label className="field">
            <span>{t('config.start')}</span>
            <input
              type="time"
              value={cfg.working_hours.start}
              onChange={(e) => setWh({ start: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('config.end')}</span>
            <input
              type="time"
              value={cfg.working_hours.end}
              onChange={(e) => setWh({ end: e.target.value })}
            />
          </label>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {WEEKDAYS.map((d) => (
            <label key={d} className="chip" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={cfg.working_hours.days.includes(d)}
                onChange={() => toggleDay(d)}
                style={{ width: 'auto', marginRight: 4 }}
              />
              {t(`config.weekday.${d}`)}
            </label>
          ))}
        </div>
      </div>

      <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
        {busy && <span className="spinner" style={{ marginRight: 6 }} />}
        {t('config.save')}
      </button>
    </section>
  );
}

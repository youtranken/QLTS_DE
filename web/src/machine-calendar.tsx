import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

interface BusyBlock {
  from: string;
  to: string;
  kind: string;
}
interface MachineCalendar {
  assetId: string;
  code: string;
  weekStart: string;
  weekEnd: string;
  busy: BusyBlock[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lịch tuần busy/free của một máy (3.2, FR-10). KHÔNG hiển thị ai mượn (AD-5). */
export function MachineCalendarPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<MachineCalendar | null>(null);
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    const qs = weekStart
      ? `?weekStart=${encodeURIComponent(weekStart)}`
      : '';
    try {
      const res = await fetch(`/api/booking/machines/${id}/calendar${qs}`);
      if (res.ok) {
        setData((await res.json()) as MachineCalendar);
        return;
      }
      setError(res.status === 404 ? t('calendar.notFound') : t('calendar.error'));
    } catch {
      setError(t('calendar.error'));
    }
  }, [id, weekStart, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const shiftWeek = (deltaDays: number) => {
    if (!data) return;
    const base = new Date(data.weekStart).getTime() + deltaDays * DAY_MS;
    // không lùi trước tuần chứa hôm nay
    if (deltaDays < 0 && base < Date.now() - 7 * DAY_MS) return;
    setWeekStart(new Date(base).toISOString());
  };

  // Giờ nghiệp vụ hiển thị theo Asia/Ho_Chi_Minh, KHÔNG theo tz trình duyệt — nhất quán
  // với biên tuần ghim ở giờ VN (review 3.2 Low-1).
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

  return (
    <section style={{ maxWidth: 800 }}>
      <button type="button" className="sm" onClick={() => navigate('/')}>
        ← {t('calendar.back')}
      </button>
      <div className="page-header">
        <h1>{t('calendar.title', { code: data?.code ?? '' })}</h1>
      </div>
      {error && <p className="alert error">{error}</p>}
      {data && (
        <>
          <div
            style={{
              display: 'flex',
              gap: '1rem',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <button type="button" className="sm" onClick={() => shiftWeek(-7)}>
              ← {t('calendar.prevWeek')}
            </button>
            <span style={{ color: 'var(--ink)' }}>
              {fmtDate(data.weekStart)} –{' '}
              {fmtDate(
                new Date(new Date(data.weekEnd).getTime() - DAY_MS).toISOString(),
              )}
            </span>
            <button type="button" className="sm" onClick={() => shiftWeek(7)}>
              {t('calendar.nextWeek')} →
            </button>
          </div>
          {data.busy.length === 0 ? (
            <p className="alert ok">{t('calendar.allFree')}</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 0.75rem' }}>
              {data.busy.map((b, i) => (
                <li
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0.5rem 0.75rem',
                    marginBottom: '0.4rem',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r)',
                    color: 'var(--ink)',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      background:
                        b.kind === 'extension'
                          ? 'var(--warn)'
                          : 'var(--danger)',
                      borderRadius: 2,
                    }}
                  />
                  {fmt(b.from)} → {fmt(b.to)}
                </li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: '0.85rem', color: 'var(--ink-2)' }}>
            {t('calendar.privacyNote')}
          </p>
        </>
      )}
    </section>
  );
}

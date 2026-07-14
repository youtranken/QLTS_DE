import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadError } from './load-state';

interface BusyBlock {
  from: string;
  to: string;
  kind: string;
  state: string;
}
interface CalMachine {
  id: string;
  code: string | null;
  type: string;
  configuration: string | null;
  busy: BusyBlock[];
}
interface PoolCalendar {
  weekStart: string;
  weekEnd: string;
  machines: CalMachine[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
// held = đã giữ chỗ chờ duyệt → "chờ duyệt"; pending/delivered → "đang mượn" (AD-5: không tên).
type BlockType = 'borrow' | 'pending';
const blockType = (state: string): BlockType =>
  state === 'held' ? 'pending' : 'borrow';

interface PlacedBlock {
  startDay: number; // 0..6 (T2..CN)
  span: number; // số ngày trong tuần
  type: BlockType;
  key: string;
}

/** UP: Lịch máy tổng (mọi máy pool) — route /lich-may, mục sidebar riêng. */
export function CalendarOverviewPage() {
  const { t, i18n } = useTranslation();
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [data, setData] = useState<PoolCalendar | null>(null);
  const [error, setError] = useState(false);
  const [machineFilter, setMachineFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | BlockType>('');

  const load = useCallback(async () => {
    setError(false);
    try {
      const qs = weekStart
        ? `?weekStart=${encodeURIComponent(weekStart)}`
        : '';
      const res = await fetch(`/api/booking/calendar${qs}`);
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      if (!res.ok) {
        setError(true);
        return;
      }
      setData((await res.json()) as PoolCalendar);
    } catch {
      setError(true);
    }
  }, [weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  const days = useMemo(() => {
    if (!data) return [];
    const base = new Date(data.weekStart).getTime();
    const wd = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base + i * DAY_MS);
      return { w: wd[i], d: d.getDate(), weekend: i >= 5 };
    });
  }, [data]);

  const weekLabel = useMemo(() => {
    if (!data) return '';
    const s = new Date(data.weekStart);
    const e = new Date(new Date(data.weekEnd).getTime() - DAY_MS);
    const fmt = (d: Date) =>
      d.toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit' });
    return `${fmt(s)} – ${fmt(e)}/${e.getFullYear()}`;
  }, [data, i18n.language]);

  const shiftWeek = (deltaDays: number) => {
    if (!data) return;
    setWeekStart(
      new Date(new Date(data.weekStart).getTime() + deltaDays * DAY_MS).toISOString(),
    );
  };

  const machines = useMemo(() => {
    if (!data) return [];
    return machineFilter
      ? data.machines.filter((m) => m.id === machineFilter)
      : data.machines;
  }, [data, machineFilter]);

  // Clamp block [from,to) vào tuần → (startDay, span). Bỏ block ngoài loại lọc.
  const placeBlocks = useCallback(
    (m: CalMachine): PlacedBlock[] => {
      if (!data) return [];
      const wkStart = new Date(data.weekStart).getTime();
      const wkEnd = new Date(data.weekEnd).getTime();
      return m.busy
        .map((b, idx): PlacedBlock | null => {
          const type = blockType(b.state);
          if (typeFilter && type !== typeFilter) return null;
          const from = Math.max(new Date(b.from).getTime(), wkStart);
          const to = Math.min(new Date(b.to).getTime(), wkEnd);
          if (to <= from) return null;
          const startDay = Math.floor((from - wkStart) / DAY_MS);
          const endDay = Math.ceil((to - wkStart) / DAY_MS);
          return {
            startDay: Math.max(0, Math.min(6, startDay)),
            span: Math.max(1, Math.min(7 - startDay, endDay - startDay)),
            type,
            key: `${m.id}-${idx}`,
          };
        })
        .filter((x): x is PlacedBlock => x !== null);
    },
    [data, typeFilter],
  );

  const typeLabel = (tp: BlockType) =>
    tp === 'pending' ? t('calendar.pending') : t('calendar.borrow');

  if (error) return <LoadError onRetry={load} />;
  if (!data) return null;

  return (
    <div className="mcal-page">
      <div className="page-header">
        <h1>{t('calendar.overviewTitle')}</h1>
      </div>
      <p className="muted mcal-sub">{t('calendar.overviewSub')}</p>

      <div className="mcal-toolbar">
        <div className="mcal-weeknav">
          <button type="button" onClick={() => shiftWeek(-7)} aria-label={t('calendar.prevWeek')}>
            ‹
          </button>
          <span className="wlabel">{weekLabel}</span>
          <button type="button" onClick={() => shiftWeek(7)} aria-label={t('calendar.nextWeek')}>
            ›
          </button>
        </div>
        <button type="button" className="ghost sm" onClick={() => setWeekStart(null)}>
          {t('calendar.today')}
        </button>
        <span style={{ flex: 1 }} />
        <select
          className="combobox"
          value={machineFilter}
          onChange={(e) => setMachineFilter(e.target.value)}
          aria-label={t('calendar.filterMachine')}
        >
          <option value="">{t('calendar.allMachines')}</option>
          {data.machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code ?? m.id}
            </option>
          ))}
        </select>
        <select
          className="combobox"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as '' | BlockType)}
          aria-label={t('calendar.filterType')}
        >
          <option value="">{t('calendar.allStatus')}</option>
          <option value="borrow">{t('calendar.borrow')}</option>
          <option value="pending">{t('calendar.pending')}</option>
        </select>
      </div>

      {machines.length === 0 ? (
        <p className="empty">{t('calendar.empty')}</p>
      ) : (
        <>
          {/* Desktop: lưới máy × 7 ngày */}
          <div className="mcal-scroll desktop-only">
            <div
              className="mcal-grid"
              style={{ gridTemplateRows: `48px repeat(${machines.length}, 64px)` }}
            >
              <div className="mcal-corner" style={{ gridColumn: 1, gridRow: 1 }}>
                {t('calendar.machineCol')}
              </div>
              {days.map((dy, i) => (
                <div
                  key={i}
                  className={`mcal-dhead${dy.weekend ? ' we' : ''}`}
                  style={{ gridColumn: 2 + i, gridRow: 1 }}
                >
                  <span className="dw">{dy.w}</span>
                  <span className="dn">{dy.d}</span>
                </div>
              ))}
              {machines.map((m, mi) => (
                <div key={`row-${m.id}`} style={{ display: 'contents' }}>
                  <div className="mcal-mcell" style={{ gridColumn: 1, gridRow: mi + 2 }}>
                    <span className="mn">{m.code ?? '—'}</span>
                    <span className="mm">
                      {m.type}
                      {m.configuration ? ` · ${m.configuration}` : ''}
                    </span>
                  </div>
                  {days.map((dy, c) => (
                    <div
                      key={`cell-${m.id}-${c}`}
                      className={`mcal-daycell${dy.weekend ? ' we' : ''}`}
                      style={{ gridColumn: 2 + c, gridRow: mi + 2 }}
                    />
                  ))}
                  {placeBlocks(m).map((b) => (
                    <div
                      key={b.key}
                      className={`mcal-block ${b.type}`}
                      style={{
                        gridColumn: `${2 + b.startDay} / span ${b.span}`,
                        gridRow: mi + 2,
                      }}
                      title={typeLabel(b.type)}
                    >
                      {typeLabel(b.type)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Mobile: list theo máy */}
          <div className="mcal-mobile mobile-only">
            {machines.map((m) => {
              const blocks = placeBlocks(m);
              return (
                <div className="mcal-mcard" key={`mob-${m.id}`}>
                  <div className="mcal-mhead">
                    <span className="mn">{m.code ?? '—'}</span>
                    <span className="mm">{m.type}</span>
                  </div>
                  <div className="mcal-mbody">
                    {blocks.length === 0 ? (
                      <div className="mcal-free">{t('calendar.freeWeek')}</div>
                    ) : (
                      blocks.map((b) => (
                        <div className="mcal-slot" key={b.key}>
                          <span className={`mcal-bar ${b.type}`} />
                          <span className="rng">
                            {days[b.startDay]?.d}/{' '}
                            {b.span > 1 ? `→ ${days[Math.min(6, b.startDay + b.span - 1)]?.d}` : ''}
                          </span>
                          <span className={`badge ${b.type === 'pending' ? 'warn' : 'ok'}`}>
                            {typeLabel(b.type)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mcal-legend">
            <span className="lg">
              <span className="sw borrow" />
              {t('calendar.borrow')}
            </span>
            <span className="lg">
              <span className="sw pending" />
              {t('calendar.pending')}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

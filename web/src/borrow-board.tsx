import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AdminDashboard } from './admin-dashboard';
import { apiFetch } from './api-client';
import { BookingSheet, PICKUP_SLOTS } from './booking-sheet';
import { LoadError } from './load-state';
import { MyRequestsPanel } from './my-requests';
import type { Me } from './panels';
import { DataTable } from './ui/data-table';

interface BoardRow {
  ticketId: string;
  assetCode: string | null;
  type: string | null;
  borrowerName: string | null;
  department: string | null;
  from: string | null;
  due: string | null;
  state: string;
  isOverdue: boolean;
  isMine: boolean;
  note: string | null;
  recurringCount: number | null;
}

interface FreePoolMachine {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
  // Phase 1b: null = rảnh ngay; else ISO giờ máy hết bận ("bận đến …").
  busyUntil?: string | null;
}

const POLL_MS = 30_000;
// #1: catalog "Máy có thể mượn" chỉ hiện tối đa 5 thẻ; còn lại bung qua "Xem tất cả".
const CATALOG_CAP = 5;

const typeIcon = (type: string | null): string => {
  const ty = (type ?? '').toLowerCase();
  if (ty.includes('laptop')) return '💻';
  if (ty.includes('desktop') || ty.includes('pc')) return '🖥️';
  if (ty.includes('printer') || ty.includes('máy in')) return '🖨️';
  if (ty.includes('monitor') || ty.includes('màn')) return '🖥️';
  if (ty.includes('phone') || ty.includes('điện thoại')) return '📱';
  return '📦';
};

interface CalBusy {
  from: string;
  to: string;
  kind: string;
}
interface MachineCal {
  busy: CalBusy[];
}
interface SlotInfo {
  /** 0 = hôm nay, 1 = ngày mai, … (-1 = kín cả tuần). */
  dayOffset: number;
  slots: string[];
}

/**
 * Giờ trống của 1 máy ở NGÀY LÀM GẦN NHẤT còn khung rảnh — tính trên ĐÚNG 6 khung gợi ý
 * (PICKUP_SLOTS, nhất quán với popup Đặt): bỏ khung đã qua & khung đang bận. Buổi tối/CN
 * hôm nay hết → tự nhảy sang ngày làm kế. Lịch busy chỉ có trong tuần fetch (BE chốt khi Đặt).
 */
function freeSlotsSoon(busy: CalBusy[]): SlotInfo {
  const now = Date.now();
  const ranges = busy.map(
    (b) => [new Date(b.from).getTime(), new Date(b.to).getTime()] as const,
  );
  for (let off = 0; off < 7; off++) {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    base.setDate(base.getDate() + off);
    if (base.getDay() === 0) continue; // CN nghỉ
    const out: string[] = [];
    for (const slot of PICKUP_SLOTS) {
      const [h, mm] = slot.split(':').map(Number);
      const t = new Date(base);
      t.setHours(h, mm, 0, 0);
      const ms = t.getTime();
      if (ms <= now) continue; // đã qua
      const busyAt = ranges.some(([bf, bt]) => bf <= ms && ms < bt);
      if (!busyAt) out.push(slot);
    }
    if (out.length > 0) return { dayOffset: off, slots: out };
  }
  return { dayOffset: -1, slots: [] };
}

/**
 * Trang chủ Borrow Board (7.5) — bảng máy đang mượn realtime cho member + admin.
 * Member: full màn + nút Đặt máy/Request của tôi ở đây (không sidebar). Admin: + dải thẻ số.
 * Poll /booking/board 30s; dòng quá hạn đỏ; đặt xong flash dòng của mình.
 */
export function BorrowBoardPage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [sheetOpen, setSheetOpen] = useState(false);
  // Máy chọn sẵn khi mở popup từ thẻ "Máy có thể mượn" (undefined = mở từ nút "Đặt máy").
  const [presetMachine, setPresetMachine] = useState<FreePoolMachine | undefined>(
    undefined,
  );
  const [showMine, setShowMine] = useState(false);
  const [flash, setFlash] = useState(false);
  const [reloadMine, setReloadMine] = useState(0);
  // 9.5+: catalog máy-first — search client-side + lọc theo loại (distinct từ pool rảnh).
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogType, setCatalogType] = useState('all');
  // #1: nhiều máy → chỉ hiện CATALOG_CAP thẻ đầu, còn lại bung khi bấm "Xem tất cả".
  const [showAllCatalog, setShowAllCatalog] = useState(false);
  // Part 2: xem giờ trống ngày làm gần nhất của 1 máy ngay trên card (trước khi mở popup đặt).
  const [slotMachine, setSlotMachine] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotInfo | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  // Cache lịch busy theo máy (session): bấm lại "Giờ trống" hiện NGAY, khỏi fetch lại.
  // Tính lại slot từ busy mỗi lần mở (giờ hiện tại trôi) — recompute rẻ, tránh network.
  const busyCache = useRef<Map<string, CalBusy[]>>(new Map());
  const toggleSlots = useCallback(
    async (id: string) => {
      if (slotMachine === id) {
        setSlotMachine(null);
        setSlots(null);
        return;
      }
      setSlotMachine(id);
      const cached = busyCache.current.get(id);
      if (cached) {
        setSlots(freeSlotsSoon(cached));
        setSlotsLoading(false);
        return;
      }
      setSlots(null);
      setSlotsLoading(true);
      try {
        const cal = await apiFetch<MachineCal>(
          `/api/booking/machines/${encodeURIComponent(id)}/calendar`,
        );
        const busy = cal.busy ?? [];
        busyCache.current.set(id, busy);
        setSlots(freeSlotsSoon(busy));
      } catch {
        setSlots({ dayOffset: -1, slots: [] });
      } finally {
        setSlotsLoading(false);
      }
    },
    [slotMachine],
  );

  // Board + pool-machines qua TanStack Query: refetch mỗi POLL_MS; placeholderData giữ dữ liệu
  // cũ khi 1 lần fetch lỗi (P0 — chỉ báo lỗi khi CHƯA từng tải). 401 xử lý ở apiFetch.
  const {
    data: rowsData,
    isError: boardIsError,
    refetch: refetchBoard,
  } = useQuery({
    queryKey: ['board'],
    queryFn: () => apiFetch<BoardRow[]>('/api/booking/board'),
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev,
  });
  const rows = rowsData ?? null;
  const { data: freeData } = useQuery({
    queryKey: ['pool-all-machines'],
    // Phase 1b: cả máy rảnh + máy bận (busyUntil) để catalog hiện "Bận đến …".
    queryFn: () => apiFetch<FreePoolMachine[]>('/api/booking/pool-all-machines'),
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev,
  });
  const free = freeData ?? [];

  const freeTypes = useMemo(
    () => Array.from(new Set(free.map((m) => m.type).filter(Boolean))).sort(),
    [free],
  );
  const freeFiltered = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    return free.filter((m) => {
      if (catalogType !== 'all' && m.type !== catalogType) return false;
      if (!q) return true;
      return `${m.code} ${m.type} ${m.configuration ?? ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [free, catalogSearch, catalogType]);

  // Đồng hồ đếm ngược mỗi POLL_MS — tách khỏi fetch, chỉ để countdown re-render.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(tick);
  }, []);

  const openBooking = (machine?: FreePoolMachine) => {
    setPresetMachine(machine);
    setSheetOpen(true);
  };

  const onBooked = useCallback(() => {
    setFlash(true);
    setReloadMine((n) => n + 1);
    busyCache.current.clear(); // đặt mới → lịch busy đổi, bỏ cache để tính lại
    void queryClient.invalidateQueries({ queryKey: ['board'] });
    void queryClient.invalidateQueries({ queryKey: ['pool-all-machines'] });
    setTimeout(() => setFlash(false), 2500);
  }, [queryClient]);

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
          timeZone: 'Asia/Ho_Chi_Minh',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  const countdown = (due: string | null): string => {
    if (!due) return '';
    const ms = new Date(due).getTime() - now;
    if (ms <= 0) return t('board.overdueBy', { d: fmtDur(-ms) });
    return t('board.dueIn', { d: fmtDur(ms) });
  };
  const fmtDur = (ms: number): string => {
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    if (d > 0) return `${d}${t('board.dUnit')} ${h}${t('board.hUnit')}`;
    if (h > 0) return `${h}${t('board.hUnit')} ${m % 60}${t('board.mUnit')}`;
    return `${m}${t('board.mUnit')}`;
  };
  // Nhãn ngày cho khối "giờ trống": Hôm nay / Ngày mai / thứ+ngày (khi phải nhảy ngày).
  const slotDayLabel = (off: number): string => {
    if (off <= 0) return t('board.today', 'Hôm nay');
    if (off === 1) return t('board.tomorrow', 'Ngày mai');
    const d = new Date();
    d.setDate(d.getDate() + off);
    return d.toLocaleDateString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    });
  };

  // Cột board: giữ nguyên nội dung ô cũ; sort/search qua DataTable. Rebuild mỗi tick `now`
  // để countdown cập nhật. `#` là số thứ tự HIỂN THỊ (đổi theo sắp xếp), không sort.
  const boardColumns = useMemo<ColumnDef<BoardRow, unknown>[]>(
    () => [
      {
        id: 'idx',
        header: '#',
        enableSorting: false,
        cell: ({ row, table }) =>
          table.getRowModel().rows.findIndex((r) => r.id === row.id) + 1,
      },
      {
        accessorKey: 'assetCode',
        header: t('board.colDevice'),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <>
              <span style={{ marginRight: 6 }}>{typeIcon(r.type)}</span>
              <span className="mono">{r.assetCode ?? '—'}</span>
              <small className="muted" style={{ marginLeft: 6 }}>
                {r.type ?? ''}
              </small>
              {r.recurringCount != null && (
                <span className="badge muted" style={{ marginLeft: 6 }}>
                  {t('board.recurring', { n: r.recurringCount })}
                </span>
              )}
            </>
          );
        },
      },
      {
        accessorKey: 'borrowerName',
        header: t('board.colBorrower'),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <>
              {r.borrowerName ?? '—'}
              {r.isMine && (
                <span className="badge ok" style={{ marginLeft: 6 }}>
                  {t('board.you')}
                </span>
              )}
              {r.department && (
                <div className="muted" style={{ fontSize: '0.82rem' }}>
                  {r.department}
                </div>
              )}
            </>
          );
        },
      },
      {
        accessorKey: 'from',
        header: t('board.colFrom'),
        cell: ({ row }) => fmt(row.original.from),
      },
      {
        accessorKey: 'due',
        header: t('board.colDue'),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <>
              {fmt(r.due)}
              <div
                className={r.isOverdue ? 'text-danger' : 'muted'}
                style={{ fontSize: '0.8rem' }}
              >
                {countdown(r.due)}
              </div>
            </>
          );
        },
      },
      {
        accessorKey: 'note',
        header: t('board.colNote'),
        cell: ({ row }) => row.original.note ?? '',
      },
      {
        accessorKey: 'state',
        header: t('board.colStatus'),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span
              className={`badge ${r.isOverdue ? 'danger' : r.state === 'in_use' ? 'ok' : 'muted'}`}
            >
              {t(`board.state.${r.state}`, r.state)}
            </span>
          );
        },
      },
    ],
    [t, i18n.language, now],
  );

  return (
    <section>
      <div
        className="page-header"
        style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}
      >
        <h1>{t('board.title')}</h1>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="ghost sm"
          onClick={() => setShowMine((v) => !v)}
        >
          {t('board.myRequests')}
        </button>
        <button type="button" className="primary" onClick={() => openBooking()}>
          {t('board.bookMachine')}
        </button>
      </div>

      {isAdmin && <AdminDashboard />}

      {/* 9.5+: catalog "Máy có thể mượn" — pool đang rảnh dạng card grid, máy-first. */}
      {free.length > 0 && (
        <div className="section-gap">
          <h2 style={{ fontSize: '1.05rem', marginBottom: '0.5rem' }}>
            {t('board.freeTitle')}
          </h2>
          <div className="catalog-toolbar">
            <input
              className="table-search"
              type="search"
              value={catalogSearch}
              placeholder={t('board.catalogSearch', 'Tìm máy: code, loại, cấu hình…')}
              aria-label={t('board.catalogSearch', 'Tìm máy: code, loại, cấu hình…')}
              onChange={(e) => setCatalogSearch(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            />
            <span className="segmented">
              <label>
                <input
                  type="radio"
                  name="catalogType"
                  checked={catalogType === 'all'}
                  onChange={() => setCatalogType('all')}
                />
                {t('board.catalogAll', 'Tất cả')}
              </label>
              {freeTypes.map((ty) => (
                <label key={ty}>
                  <input
                    type="radio"
                    name="catalogType"
                    checked={catalogType === ty}
                    onChange={() => setCatalogType(ty)}
                  />
                  {ty}
                </label>
              ))}
            </span>
            <button type="button" className="ghost" onClick={() => openBooking()}>
              {t('board.catalogAdvanced', '+ Nâng cao')}
            </button>
          </div>
          {freeFiltered.length === 0 ? (
            <p className="empty">
              {t('board.catalogEmpty', 'Không có máy khớp bộ lọc.')}
            </p>
          ) : (
            <>
              <div className="mcatalog dense">
                {(showAllCatalog
                  ? freeFiltered
                  : freeFiltered.slice(0, CATALOG_CAP)
                ).map((m) => {
                  const busy = m.busyUntil != null;
                  const slotsOpen = slotMachine === m.id;
                  return (
                    <div key={m.id} className="mcard mcard-sm">
                      <div className="mc-head">
                        <span className="mc-ico">{typeIcon(m.type)}</span>
                        <span className="mc-code">{m.code}</span>
                        {busy ? (
                          <span className="avail busy">
                            {t('board.catalogBusyShort', 'Bận')}
                          </span>
                        ) : (
                          <span className="avail free">
                            {t('board.catalogFree', 'Rảnh ngay')}
                          </span>
                        )}
                      </div>
                      <div className="mc-spec">
                        {m.type}
                        {m.configuration ? ` · ${m.configuration}` : ''}
                        {busy && (
                          <span className="muted">
                            {' · '}
                            {t('board.catalogBusyUntil', 'Bận đến {{time}}', {
                              time: fmt(m.busyUntil ?? null),
                            })}
                          </span>
                        )}
                      </div>
                      <div className="mc-actions">
                        {!busy && (
                          <button
                            type="button"
                            className="ghost sm"
                            aria-expanded={slotsOpen}
                            onClick={() => void toggleSlots(m.id)}
                          >
                            {slotsOpen
                              ? t('board.hideSlots', 'Ẩn giờ')
                              : t('board.showSlots', 'Giờ trống ▾')}
                          </button>
                        )}
                        <button
                          type="button"
                          className={busy ? 'sm' : 'primary sm'}
                          onClick={() => openBooking(m)}
                        >
                          {busy
                            ? t('board.catalogSchedule', 'Đặt lịch')
                            : t('board.catalogBook', 'Đặt')}
                        </button>
                      </div>
                      {slotsOpen && (
                        <div className="slot-row">
                          {slotsLoading ? (
                            <span className="muted">…</span>
                          ) : slots && slots.slots.length > 0 ? (
                            <>
                              <span className="slot-day">
                                {slotDayLabel(slots.dayOffset)}
                              </span>
                              {slots.slots.map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  className="slotchip"
                                  onClick={() => openBooking(m)}
                                  title={t('board.bookAt', 'Đặt máy này lúc {{s}}', {
                                    s,
                                  })}
                                >
                                  {s}
                                </button>
                              ))}
                            </>
                          ) : (
                            <span className="muted" style={{ fontSize: '0.8rem' }}>
                              {t(
                                'board.noSlotsWeek',
                                'Kín lịch tuần này — bấm Đặt để chọn ngày khác',
                              )}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {freeFiltered.length > CATALOG_CAP && (
                <button
                  type="button"
                  className="ghost sm"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => setShowAllCatalog((v) => !v)}
                >
                  {showAllCatalog
                    ? t('board.catalogCollapse', 'Thu gọn')
                    : t('board.catalogShowAll', 'Xem tất cả ({{n}}) →', {
                        n: freeFiltered.length,
                      })}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {showMine && <MyRequestsPanel me={me} reloadKey={reloadMine} />}

      {rows === null ? (
        boardIsError ? (
          <LoadError onRetry={() => void refetchBoard()} />
        ) : (
          <p className="muted">{t('board.loading')}</p>
        )
      ) : (
        <DataTable
          data={rows}
          columns={boardColumns}
          emptyText={t('board.empty')}
          searchPlaceholder={t('board.search')}
          tableClassName="board-table"
          rowClassName={(r) =>
            `${r.isOverdue ? 'row-overdue' : ''}${
              flash && r.isMine ? ' row-flash' : ''
            }`.trim()
          }
        />
      )}

      {sheetOpen && (
        <BookingSheet
          me={me}
          presetMachine={presetMachine}
          onClose={() => setSheetOpen(false)}
          onBooked={onBooked}
        />
      )}
    </section>
  );
}

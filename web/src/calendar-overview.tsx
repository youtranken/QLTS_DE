import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadError } from './load-state';
import { DatePicker } from './ui/date-picker';
import { BookingSheet } from './booking-sheet';
import { ExtensionDialog } from './extension-dialog';
import { ExtensionApproveDialog } from './extension-approve-dialog';
import { ForceCancelButton } from './force-cancel-button';
import type { Me } from './panels';

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
interface FreeMachine {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
}
interface BoardRow {
  ticketId: string;
  assetCode: string | null;
  type: string | null;
  borrowerName: string | null;
  from: string | null;
  due: string | null;
  state: string;
  isOverdue: boolean;
  isMine: boolean;
  // Gia hạn (Epic 4): version (member optimistic lock), kind (ẩn ở định kỳ), đếm lần, cờ treo.
  version: number;
  kind: string;
  extensionCount: number;
  hasPendingExtension: boolean;
}

/** Yêu cầu gia hạn treo (member đã xin) — để admin duyệt thẳng trên board. */
interface PendingExt {
  extensionId: string;
  extVersion: number;
  oldDue: string | null;
  newDue: string | null;
  usedCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// held = giữ chỗ chờ duyệt → "chờ duyệt"; pending/delivered → "đang mượn" (AD-5: không tên).
type BlockType = 'borrow' | 'pending';
const blockType = (state: string): BlockType =>
  state === 'held' ? 'pending' : 'borrow';

interface PlacedBlock {
  startDay: number;
  span: number;
  type: BlockType;
  key: string;
}

/** UP: Lịch máy tổng + panel đặt nhanh (máy trống) + bảng đang mượn — route /lich-may. */
export function CalendarOverviewPage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [data, setData] = useState<PoolCalendar | null>(null);
  // null = CHƯA tải xong (khác [] = đã tải, không có máy rảnh) — tránh nhấp nháy
  // "không có máy rảnh" lúc đang tải (review L3).
  const [free, setFree] = useState<FreeMachine[] | null>(null);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [error, setError] = useState(false);
  const [machineFilter, setMachineFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | BlockType>('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [preset, setPreset] = useState<FreeMachine | undefined>(undefined);
  const [boardMine, setBoardMine] = useState(false);
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  // Gia hạn: hàng đang mở dialog + đường (member xin duyệt / admin áp thẳng).
  const [extRow, setExtRow] = useState<{ row: BoardRow; mode: 'member' | 'admin' } | null>(null);
  // Duyệt gia hạn treo NGAY trên board (admin): map ticketId → yêu cầu member đã xin.
  const [pendingExt, setPendingExt] = useState<Map<string, PendingExt>>(new Map());
  const [approveRow, setApproveRow] = useState<{
    assetCode: string | null;
    pending: PendingExt;
  } | null>(null);

  const loadCalendar = useCallback(async () => {
    setError(false);
    try {
      const qs = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : '';
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

  const loadSide = useCallback(async () => {
    try {
      const [fRes, bRes] = await Promise.all([
        fetch('/api/booking/pool-machines'),
        fetch('/api/booking/board'),
      ]);
      if (fRes.ok) setFree((await fRes.json()) as FreeMachine[]);
      if (bRes.ok) setBoard((await bRes.json()) as BoardRow[]);
    } catch {
      /* rail/board phụ trợ — lỗi không chặn lịch */
    }
    // Admin: nạp yêu cầu gia hạn treo để đổi nút Gia hạn→Duyệt trên đúng row (chi tiết ngày xin).
    if (!isAdmin) return;
    try {
      const eRes = await fetch('/api/admin/tickets/extensions');
      if (!eRes.ok) return;
      const list = (await eRes.json()) as Array<{
        extensionId: string;
        version: number;
        ticketId: string;
        oldDue: string | null;
        newDue: string | null;
        usedCount: number;
      }>;
      setPendingExt(
        new Map(
          list.map((e) => [
            e.ticketId,
            {
              extensionId: e.extensionId,
              extVersion: e.version,
              oldDue: e.oldDue,
              newDue: e.newDue,
              usedCount: e.usedCount,
            },
          ]),
        ),
      );
    } catch {
      /* phụ trợ */
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar]);
  useEffect(() => {
    void loadSide();
  }, [loadSide]);

  const openBooking = (m?: FreeMachine) => {
    setPreset(m);
    setSheetOpen(true);
  };

  const fmtDate = useCallback(
    (iso: string | null) =>
      iso
        ? new Date(iso).toLocaleString(i18n.language, {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '—',
    [i18n.language],
  );

  // Lịch máy tổng hiển thị 14 ngày (2 tuần) — nhãn thứ lặp theo tuần (i % 7).
  const days = useMemo(() => {
    if (!data) return [];
    const base = new Date(data.weekStart).getTime();
    const wd = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date(base + i * DAY_MS);
      return { w: wd[i % 7], d: d.getDate(), weekend: i % 7 >= 5 };
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

  const machines = useMemo(() => {
    if (!data) return [];
    return machineFilter
      ? data.machines.filter((m) => m.id === machineFilter)
      : data.machines;
  }, [data, machineFilter]);

  // Đổi tuần mà máy đã lọc không còn trong danh sách tuần mới → reset (khỏi lưới rỗng giả
  // như "không có máy" trong khi các máy khác vẫn có; mẫu reset filter mồ côi ở assets).
  useEffect(() => {
    if (data && machineFilter && !data.machines.some((m) => m.id === machineFilter)) {
      setMachineFilter('');
    }
  }, [data, machineFilter]);

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
          const clampedStart = Math.max(0, Math.min(13, startDay));
          return {
            startDay: clampedStart,
            span: Math.max(1, Math.min(14 - clampedStart, endDay - clampedStart)),
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

  const boardRows = useMemo(
    () => (boardMine ? board.filter((r) => r.isMine) : board),
    [board, boardMine],
  );

  if (error) return <LoadError onRetry={loadCalendar} />;
  if (!data) return null;

  // Điều hướng theo THÁNG + chọn NGÀY trong tháng (giữ lưới tuần): chọn ngày → nhảy tới tuần
  // chứa ngày đó; ‹ › đổi tháng để xem xa hơn. Ngày giới hạn trong tháng đang xem.
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const toYmd = (d: Date) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  // MỘT ô "Chọn ngày" duy nhất: chọn ngày bất kỳ → nhảy tới tuần chứa ngày đó; đổi tháng
  // ngay trong lịch của DatePicker (không cần nav tháng riêng). 12h để không lệch múi giờ.
  const pickDay = (ymd: string) => {
    if (ymd) setWeekStart(new Date(`${ymd}T12:00:00`).toISOString());
  };
  const dayValue = toYmd(new Date(data.weekStart));

  return (
    <div className="mcal-page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1>{t('calendar.overviewTitle')}</h1>
        <span style={{ flex: 1 }} />
        <button type="button" className="primary" onClick={() => openBooking()}>
          {t('board.bookMachine')}
        </button>
      </div>
      <p className="muted mcal-sub">{t('calendar.overviewSub')}</p>

      <div className="mcal-toolbar">
        <label className="mcal-daypick">
          <span className="muted">{t('calendar.pickDay', 'Chọn ngày')}</span>
          <DatePicker
            value={dayValue}
            clearable={false}
            ariaLabel={t('calendar.pickDay', 'Chọn ngày')}
            onChange={pickDay}
          />
        </label>
        {/* Tuần đang hiển thị (dd/mm–dd/mm) chứa ngày đã chọn. */}
        <span className="muted mcal-weekrange">{weekLabel}</span>
        <button type="button" className="ghost sm" onClick={() => setWeekStart(null)}>
          {t('calendar.today')}
        </button>
        <span style={{ flex: 1 }} />
        <select
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
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as '' | BlockType)}
          aria-label={t('calendar.filterType')}
        >
          <option value="">{t('calendar.allStatus')}</option>
          <option value="borrow">{t('calendar.borrow')}</option>
          <option value="pending">{t('calendar.pending')}</option>
        </select>
        {(machineFilter || typeFilter) && (
          <button
            type="button"
            className="ghost sm"
            onClick={() => {
              setMachineFilter('');
              setTypeFilter('');
            }}
          >
            {t('assets.clearFilters')}
          </button>
        )}
      </div>
      {(machineFilter || typeFilter) && (
        <div className="active-filters">
          <span className="af-label">{t('assets.activeFilters', 'Đang lọc')}</span>
          {machineFilter && (
            <span className="chip filter-chip">
              <b>{t('calendar.filterMachine')}:</b>
              {data.machines.find((m) => m.id === machineFilter)?.code ?? machineFilter}
              <button
                type="button"
                aria-label={t('assets.clearFilters')}
                onClick={() => setMachineFilter('')}
              >
                ✕
              </button>
            </span>
          )}
          {typeFilter && (
            <span className="chip filter-chip">
              <b>{t('calendar.filterType')}:</b>
              {typeLabel(typeFilter)}
              <button
                type="button"
                aria-label={t('assets.clearFilters')}
                onClick={() => setTypeFilter('')}
              >
                ✕
              </button>
            </span>
          )}
        </div>
      )}

      <div className="mcal-layout">
        {/* Lịch (chính) */}
        <div className="mcal-main">
          {machines.length === 0 ? (
            <p className="empty">{t('calendar.overviewEmpty')}</p>
          ) : (
            <>
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
                                {days[b.startDay]?.d}
                                {b.span > 1
                                  ? ` → ${days[Math.min(6, b.startDay + b.span - 1)]?.d}`
                                  : ''}
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

        {/* Rail máy trống — đặt nhanh (bên phải) */}
        <aside className="mcal-rail">
          <h2>{t('calendar.railTitle')}</h2>
          {free === null ? null : free.length === 0 ? (
            <div className="empty">{t('calendar.railEmpty')}</div>
          ) : (
            <div className="mcal-freelist">
              {free.map((m) => (
                <div className="mcal-freecard" key={m.id}>
                  <div className="fc-main">
                    <span className="fc-code">{m.code}</span>
                    <span className="fc-spec">
                      {m.type}
                      {m.configuration ? ` · ${m.configuration}` : ''}
                    </span>
                  </div>
                  <button type="button" className="primary sm" onClick={() => openBooking(m)}>
                    {t('board.book', 'Đặt')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {/* Máy đang mượn / chờ giao (dưới) */}
      <section className="section-gap">
        <div className="mcal-active-head">
          <h2>{t('calendar.activeTitle')}</h2>
          <span className="segmented">
            <label>
              <input
                type="radio"
                name="calBoardFilter"
                checked={!boardMine}
                onChange={() => setBoardMine(false)}
              />
              {t('board.filterAll', 'Tất cả')}
            </label>
            <label>
              <input
                type="radio"
                name="calBoardFilter"
                checked={boardMine}
                onChange={() => setBoardMine(true)}
              />
              {t('board.filterMine', 'Của tôi')}
            </label>
          </span>
        </div>
        {boardRows.length === 0 ? (
          <p className="empty">{t('calendar.activeEmpty')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('board.colDevice')}</th>
                  <th>{t('board.colBorrower')}</th>
                  <th>{t('board.colFromDate', 'Ngày nhận')}</th>
                  <th>{t('board.colToDate', 'Ngày trả')}</th>
                  <th>{t('board.colStatus')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {boardRows.map((r) => {
                  const cls = r.isOverdue
                    ? 'danger'
                    : r.state === 'in_use'
                      ? 'ok'
                      : r.state === 'awaiting_pickup'
                        ? 'warn'
                        : 'muted';
                  // Gia hạn: chỉ ticket đang mượn, không phải buổi định kỳ. Admin gia hạn thẳng
                  // MỌI hàng (kể cả quá hạn); member chỉ hàng của mình & chưa quá hạn (BE cũng chặn).
                  const canExtend =
                    r.state === 'in_use' &&
                    r.kind !== 'recurring' &&
                    (isAdmin || (r.isMine && !r.isOverdue));
                  return (
                    <tr key={r.ticketId}>
                      <td>
                        <span className="mono">{r.assetCode ?? '—'}</span>
                        {r.type ? <span className="muted"> · {r.type}</span> : null}
                      </td>
                      <td>
                        {r.borrowerName ?? '—'}
                        {r.isMine && <span className="badge ok"> {t('board.you')}</span>}
                      </td>
                      <td>{fmtDate(r.from)}</td>
                      <td>{fmtDate(r.due)}</td>
                      <td>
                        <span className={`badge ${cls}`}>
                          {t(`board.state.${r.state}`, r.state)}
                        </span>
                        {r.hasPendingExtension && (
                          <span className="badge warn" style={{ marginLeft: 6 }}>
                            {t('extension.pendingChip')}
                          </span>
                        )}
                      </td>
                      <td className="table-actions">
                        {/* Admin + có yêu cầu gia hạn treo → nút DUYỆT (mở popup xem ngày member
                            đã xin, duyệt/từ chối). Ngược lại giữ nút Gia hạn/adminExtend. */}
                        {isAdmin &&
                        r.hasPendingExtension &&
                        pendingExt.get(r.ticketId) ? (
                          <button
                            type="button"
                            className="sm primary"
                            onClick={() =>
                              setApproveRow({
                                assetCode: r.assetCode,
                                pending: pendingExt.get(r.ticketId)!,
                              })
                            }
                          >
                            {t('extapprove.approve')}
                          </button>
                        ) : (
                          canExtend && (
                            <button
                              type="button"
                              className="sm"
                              // Member: đã có yc treo thì chờ duyệt (không xin chồng). Admin áp thẳng được.
                              disabled={!isAdmin && r.hasPendingExtension}
                              title={
                                !isAdmin && r.hasPendingExtension
                                  ? t('extension.pendingHint')
                                  : undefined
                              }
                              onClick={() =>
                                setExtRow({
                                  row: r,
                                  mode: isAdmin ? 'admin' : 'member',
                                })
                              }
                            >
                              {isAdmin
                                ? t('extension.actionAdmin')
                                : t('extension.action')}
                            </button>
                          )
                        )}
                        {/* Hủy cưỡng chế (audit H-2) — CHỈ admin, và chỉ cho lượt
                            thường: chuỗi định kỳ BE trả IS_RECURRING nên không hiện. */}
                        {/* Ẩn cho in_use: máy đã giao phải đi đường Trả, BE chặn force-cancel
                            in_use (ALREADY_DELIVERED) — review M1. */}
                        {isAdmin &&
                          r.kind !== 'recurring' &&
                          r.state !== 'in_use' && (
                            <>
                              {' '}
                              <ForceCancelButton
                                ticketId={r.ticketId}
                                me={me}
                                onDone={() => {
                                  void loadCalendar();
                                  void loadSide();
                                }}
                              />
                            </>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {sheetOpen && (
        <BookingSheet
          me={me}
          presetMachine={preset}
          onClose={() => setSheetOpen(false)}
          onBooked={() => {
            setSheetOpen(false);
            void loadCalendar();
            void loadSide();
          }}
        />
      )}

      {extRow && (
        <ExtensionDialog
          me={me}
          ticketId={extRow.row.ticketId}
          assetCode={extRow.row.assetCode}
          due={extRow.row.due}
          version={extRow.row.version}
          extensionCount={extRow.row.extensionCount}
          mode={extRow.mode}
          onClose={() => setExtRow(null)}
          onDone={() => {
            setExtRow(null);
            void loadCalendar();
            void loadSide();
          }}
        />
      )}

      {approveRow && (
        <ExtensionApproveDialog
          me={me}
          assetCode={approveRow.assetCode}
          extensionId={approveRow.pending.extensionId}
          extVersion={approveRow.pending.extVersion}
          oldDue={approveRow.pending.oldDue}
          newDue={approveRow.pending.newDue}
          usedCount={approveRow.pending.usedCount}
          onClose={() => setApproveRow(null)}
          onDone={() => {
            setApproveRow(null);
            void loadCalendar();
            void loadSide();
          }}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminDashboard } from './admin-dashboard';
import { apiFetch } from './api-client';
import { BookingSheet } from './booking-sheet';
import { LoadError } from './load-state';
import type { Me } from './panels';
import { DataTable } from './ui/data-table';
import {
  POLL_MS,
  freeSlotsSoon,
  type BoardRow,
  type CalBusy,
  type FreePoolMachine,
  type MachineCal,
  type SlotInfo,
} from './board-types';
import { useBoardColumns } from './board-columns';
import { BoardCatalog } from './board-catalog';

/**
 * Trang chủ Borrow Board (7.5) — bảng máy đang mượn realtime cho member + admin.
 * Member: full màn + nút Đặt máy/Request của tôi ở đây (không sidebar). Admin: + dải thẻ số.
 * Poll /booking/board 30s; dòng quá hạn đỏ; đặt xong flash dòng của mình.
 * Catalog máy-first + bộ cột bảng tách ra board-catalog / board-columns (§6).
 */
export function BorrowBoardPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [sheetOpen, setSheetOpen] = useState(false);
  // Máy chọn sẵn khi mở popup từ thẻ "Máy có thể mượn" (undefined = mở từ nút "Đặt máy").
  const [presetMachine, setPresetMachine] = useState<FreePoolMachine | undefined>(
    undefined,
  );
  const [flash, setFlash] = useState(false);
  // Filter bảng máy: 'all' = tất cả máy đang mượn/chờ giao; 'mine' = chỉ của tôi.
  const [boardFilter, setBoardFilter] = useState<'all' | 'mine'>('all');
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
    busyCache.current.clear(); // đặt mới → lịch busy đổi, bỏ cache để tính lại
    void queryClient.invalidateQueries({ queryKey: ['board'] });
    void queryClient.invalidateQueries({ queryKey: ['pool-all-machines'] });
    setTimeout(() => setFlash(false), 2500);
  }, [queryClient]);

  const boardColumns = useBoardColumns(now);

  return (
    <section>
      <div
        className="page-header"
        style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}
      >
        <h1>{t('board.title')}</h1>
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" className="primary" onClick={() => openBooking()}>
          {t('board.bookMachine')}
        </button>
      </div>

      {isAdmin && <AdminDashboard />}

      <BoardCatalog
        free={free}
        openBooking={openBooking}
        slotMachine={slotMachine}
        slots={slots}
        slotsLoading={slotsLoading}
        toggleSlots={toggleSlots}
      />

      <div className="section-gap board-head">
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>
          {t('board.tableTitle', 'Máy đang mượn / chờ giao')}
        </h2>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="segmented">
          <label>
            <input
              type="radio"
              name="boardFilter"
              checked={boardFilter === 'all'}
              onChange={() => setBoardFilter('all')}
            />
            {t('board.filterAll', 'Tất cả')}
          </label>
          <label>
            <input
              type="radio"
              name="boardFilter"
              checked={boardFilter === 'mine'}
              onChange={() => setBoardFilter('mine')}
            />
            {t('board.filterMine', 'Của tôi')}
          </label>
        </span>
      </div>
      {rows === null ? (
        boardIsError ? (
          <LoadError onRetry={() => void refetchBoard()} />
        ) : (
          <p className="muted">{t('board.loading')}</p>
        )
      ) : (
        <DataTable
          data={boardFilter === 'mine' ? rows.filter((r) => r.isMine) : rows}
          columns={boardColumns}
          emptyText={
            boardFilter === 'mine'
              ? t('board.emptyMine', 'Bạn chưa có máy nào đang mượn/chờ giao.')
              : t('board.empty')
          }
          searchPlaceholder={t('board.search')}
          tableClassName="board-table"
          stackOnMobile
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

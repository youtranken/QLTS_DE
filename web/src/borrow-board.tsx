import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AdminDashboard } from './admin-dashboard';
import { apiFetch } from './api-client';
import { BookingSheet } from './booking-sheet';
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
}

const POLL_MS = 30_000;

const typeIcon = (type: string | null): string => {
  const ty = (type ?? '').toLowerCase();
  if (ty.includes('laptop')) return '💻';
  if (ty.includes('desktop') || ty.includes('pc')) return '🖥️';
  if (ty.includes('printer') || ty.includes('máy in')) return '🖨️';
  if (ty.includes('monitor') || ty.includes('màn')) return '🖥️';
  if (ty.includes('phone') || ty.includes('điện thoại')) return '📱';
  return '📦';
};

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
  // 9.5: mở popup đặt máy với máy chọn sẵn từ bảng "Máy có thể mượn".
  const [presetAsset, setPresetAsset] = useState<string | undefined>(undefined);
  const [showMine, setShowMine] = useState(false);
  const [flash, setFlash] = useState(false);
  const [reloadMine, setReloadMine] = useState(0);
  // 9.5+: catalog máy-first — search client-side + lọc theo loại (distinct từ pool rảnh).
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogType, setCatalogType] = useState('all');

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
    queryKey: ['pool-machines'],
    queryFn: () => apiFetch<FreePoolMachine[]>('/api/booking/pool-machines'),
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

  const openBooking = (assetId?: string) => {
    setPresetAsset(assetId);
    setSheetOpen(true);
  };

  const onBooked = useCallback(() => {
    setFlash(true);
    setReloadMine((n) => n + 1);
    void queryClient.invalidateQueries({ queryKey: ['board'] });
    void queryClient.invalidateQueries({ queryKey: ['pool-machines'] });
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
            <div className="mcatalog">
              {freeFiltered.map((m) => (
                <div key={m.id} className="mcard">
                  <div className="mc-ico">{typeIcon(m.type)}</div>
                  <div className="mc-code">{m.code}</div>
                  <div className="mc-spec">
                    {m.type}
                    {m.configuration ? ` · ${m.configuration}` : ''}
                  </div>
                  <span className="avail free">
                    {t('board.catalogFree', 'Rảnh ngay')}
                  </span>
                  <button
                    type="button"
                    className="primary mc-foot"
                    onClick={() => openBooking(m.id)}
                  >
                    {t('board.catalogBorrow', 'Mượn')}
                  </button>
                </div>
              ))}
            </div>
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
          presetAssetId={presetAsset}
          onClose={() => setSheetOpen(false)}
          onBooked={onBooked}
        />
      )}
    </section>
  );
}

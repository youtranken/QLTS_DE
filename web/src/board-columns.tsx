import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ColumnDef } from '@tanstack/react-table';
import { NEAR_DUE_MS, dOnly, hOnly, type BoardRow } from './board-types';

/**
 * Cột bảng "Máy đang mượn / chờ giao": 4 cột Ngày/Giờ Nhận-Trả (màu cảnh báo ở cột Trả) +
 * Tình trạng. Rebuild mỗi tick `now` để countdown + màu cập nhật. Tách khỏi BorrowBoardPage
 * (§6) — countdown/dueClass là hiển thị của bảng nên gói cùng.
 */
export function useBoardColumns(now: number): ColumnDef<BoardRow, unknown>[] {
  const { t, i18n } = useTranslation();

  const fmtDur = (ms: number): string => {
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    if (d > 0) return `${d}${t('board.dUnit')} ${h}${t('board.hUnit')}`;
    if (h > 0) return `${h}${t('board.hUnit')} ${m % 60}${t('board.mUnit')}`;
    return `${m}${t('board.mUnit')}`;
  };
  const countdown = (due: string | null): string => {
    if (!due) return '';
    const ms = new Date(due).getTime() - now;
    if (ms <= 0) return t('board.overdueBy', { d: fmtDur(-ms) });
    return t('board.dueIn', { d: fmtDur(ms) });
  };
  // Màu cột Trả: quá hạn → đỏ chớp; gần tới giờ trả (≤2h) → cam chớp; còn xa → thường.
  const dueClass = (due: string | null): string => {
    if (!due) return '';
    const ms = new Date(due).getTime() - now;
    if (ms <= 0) return 'due-over';
    if (ms <= NEAR_DUE_MS) return 'due-near';
    return '';
  };

  return useMemo<ColumnDef<BoardRow, unknown>[]>(
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
            </>
          );
        },
      },
      {
        accessorKey: 'from',
        header: t('board.colFromDate', 'Ngày nhận'),
        cell: ({ row }) => dOnly(row.original.from),
      },
      {
        id: 'fromTime',
        header: t('board.colFromTime', 'Giờ nhận'),
        enableSorting: false,
        cell: ({ row }) => <span className="mono">{hOnly(row.original.from)}</span>,
      },
      {
        accessorKey: 'due',
        header: t('board.colToDate', 'Ngày trả'),
        cell: ({ row }) => (
          <span className={dueClass(row.original.due)}>
            {dOnly(row.original.due)}
          </span>
        ),
      },
      {
        id: 'toTime',
        header: t('board.colToTime', 'Giờ trả'),
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <>
              <span className={`mono ${dueClass(r.due)}`}>{hOnly(r.due)}</span>
              <div style={{ fontSize: '0.78rem' }} className={dueClass(r.due)}>
                {countdown(r.due)}
              </div>
            </>
          );
        },
      },
      {
        accessorKey: 'state',
        header: t('board.colStatus'),
        cell: ({ row }) => {
          const r = row.original;
          // Đang mượn (xanh, đỏ nếu quá hạn) · Chờ giao (cam) · Chờ duyệt (xám).
          const cls = r.isOverdue
            ? 'danger'
            : r.state === 'in_use'
              ? 'ok'
              : r.state === 'awaiting_pickup'
                ? 'warn'
                : 'muted';
          return (
            <span className={`badge ${cls}`}>
              {t(`board.state.${r.state}`, r.state)}
            </span>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, i18n.language, now],
  );
}

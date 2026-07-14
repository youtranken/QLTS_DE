import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ColumnDef } from '@tanstack/react-table';
import { RowActionsMenu } from './asset-row-actions';
import type { RowAction } from './asset-row-actions';
import { CodeCell, TypeCell } from './asset-cell';
import type { ExpandMeta } from './ui/data-table';
import {
  STATUS_BADGE,
  formatVnd,
  formatDmy,
  daysUntil,
  EXPIRY_SOON_DAYS,
} from './asset-types';
import type { AssetRow } from './asset-types';

/**
 * Bộ cột DataTable của sổ tài sản. Tab Phần mềm (softwareOnly) và Sổ tài sản dùng bộ cột
 * KHÁC nhau (sw-license-model-redesign): phần mềm định danh bằng Tên license + Máy + Kỳ hạn;
 * máy có cột thông số English cố định + "Pool". Tách khỏi AssetsPage (§6) — chỉ dựng cột.
 */
export function useAssetColumns(opts: {
  softwareOnly: boolean;
  disposedOnly: boolean;
  openEdit: (id: string) => void | Promise<void>;
  copyFrom: (id: string) => void | Promise<void>;
  handleDelete: (row: AssetRow) => void | Promise<void>;
  onPurge: (row: AssetRow) => void;
  onDispose: (row: AssetRow) => void;
  setTransferSw: (a: AssetRow) => void;
  lifecycleActionsFor: (a: AssetRow) => RowAction[];
}): ColumnDef<AssetRow, unknown>[] {
  const { t } = useTranslation();
  const {
    softwareOnly,
    disposedOnly,
    openEdit,
    copyFrom,
    handleDelete,
    onPurge,
    onDispose,
    setTransferSw,
    lifecycleActionsFor,
  } = opts;

  // id cột KHỚP whitelist BE (code/type/status/assignee) → map thẳng sang ?sort=.
  return useMemo<ColumnDef<AssetRow, unknown>[]>(() => {
    const statusCol: ColumnDef<AssetRow, unknown> = {
      id: 'status',
      accessorKey: 'status',
      header: t('assets.col.status'),
      cell: ({ row }) => (
        <span className={`badge ${STATUS_BADGE[row.original.status] ?? 'muted'}`}>
          {t(`assets.status.${row.original.status}`)}
        </span>
      ),
    };
    // Action gom vào menu "⋯" (3-chấm) cho gọn. Kho thanh lý: hồ sơ đã chốt — chỉ "Tái sử dụng".
    const actionsCol: ColumnDef<AssetRow, unknown> = {
      id: 'actions',
      header: t('assets.col.action'),
      enableSorting: false,
      cell: ({ row }) => {
        const a = row.original;
        // Dòng đã thanh lý (kể cả khi lọc status=disposed ở sổ tài sản): hồ sơ đã chốt →
        // chỉ "Tái sử dụng", KHÔNG Sửa/Xóa (BE chặn, tránh action ra lỗi khó hiểu).
        const actions: RowAction[] = (disposedOnly || a.status === 'disposed')
          ? [
              { label: t('assets.reuse', 'Tái sử dụng'), onClick: () => void copyFrom(a.id) },
              {
                label: t('assets.purge', 'Xóa vĩnh viễn'),
                danger: true,
                onClick: () => onPurge(a),
              },
            ]
          : [
              { label: t('assets.edit'), onClick: () => void openEdit(a.id) },
              ...(softwareOnly
                ? [
                    {
                      label: t('software.assignMachine'),
                      onClick: () => setTransferSw(a),
                    },
                    { label: t('software.copy'), onClick: () => void copyFrom(a.id) },
                  ]
                : []),
              // Khóa sửa chữa / Mở khóa / Pool (chỉ máy; software → []).
              ...lifecycleActionsFor(a),
              // Phần mềm: Thanh lý (→ Kho thanh lý) thay Xóa cứng; máy: Xóa cứng như cũ.
              softwareOnly
                ? {
                    label: t('assets.disposeAction', 'Thanh lý'),
                    danger: true,
                    onClick: () => onDispose(a),
                  }
                : {
                    label: t('assets.delete'),
                    danger: true,
                    onClick: () => void handleDelete(a),
                  },
            ];
        return <RowActionsMenu actions={actions} />;
      },
    };
    if (softwareOnly) {
      return [
        {
          id: 'license',
          accessorKey: 'licenseName',
          header: t('assets.licenseName'),
          enableSorting: false, // định danh mới; sort theo tên license chưa whitelist BE
          cell: ({ row }) => row.original.licenseName ?? '—',
        },
        {
          id: 'host',
          header: t('assets.hostCol'),
          enableSorting: false,
          cell: ({ row }) =>
            row.original.installedOnCode ? (
              <span className="mono">{row.original.installedOnCode}</span>
            ) : (
              <span className="muted">{t('assets.installedNone')}</span>
            ),
        },
        {
          id: 'assignee', // BE sort 'assignee' đã derive holder từ máy cho phần mềm
          accessorKey: 'assignedUserName',
          header: t('assets.assignee'),
          cell: ({ row }) => {
            const r = row.original;
            const holder = r.assignedUserName ?? r.assignedUserSub;
            if (holder) return holder;
            // Phân biệt: chưa gắn máy (—) vs gắn máy nhưng máy chưa có người đứng tên.
            return r.installedOnCode ? (
              <span className="muted">{t('assets.hostNoHolder')}</span>
            ) : (
              '—'
            );
          },
        },
        {
          id: 'cost',
          header: t('assets.col.cost'),
          enableSorting: false,
          cell: ({ row }) =>
            row.original.cost == null ? (
              '—'
            ) : (
              <span className="mono">{formatVnd(row.original.cost)}</span>
            ),
        },
        {
          id: 'startDate',
          header: t('assets.col.startDate'),
          enableSorting: false,
          cell: ({ row }) => formatDmy(row.original.startDate),
        },
        {
          id: 'endDate',
          header: t('assets.col.endDate'),
          enableSorting: false,
          cell: ({ row }) => {
            const r = row.original;
            if (r.licenseType === 'perpetual') return t('assets.licensePerpetual');
            if (!r.endDate) return '—';
            // Chỉ 'term' mới cảnh báo hạn — bản không rõ loại (licenseType null) chỉ hiện ngày.
            const n = r.licenseType === 'term' ? daysUntil(r.endDate) : NaN;
            // ≤30 ngày (hoặc quá hạn) → đỏ nhấp nháy + đếm ngược.
            if (Number.isFinite(n) && n <= EXPIRY_SOON_DAYS) {
              return (
                <span className="seat-due due-over">
                  <span>{formatDmy(r.endDate)}</span>
                  <small>
                    {n < 0
                      ? t('software.overdueDays', { n: Math.abs(n) })
                      : t('software.daysLeft', { n })}
                  </small>
                </span>
              );
            }
            return formatDmy(r.endDate);
          },
        },
        {
          id: 'note',
          header: t('assets.col.note', 'Ghi chú'),
          enableSorting: false,
          cell: ({ row }) =>
            row.original.note ? (
              <span className="cell-note" title={row.original.note}>
                {row.original.note}
              </span>
            ) : (
              '—'
            ),
        },
        statusCol,
        actionsCol,
      ];
    }
    // Bảng Tài sản (đại tu UAT): cột thông số theo tên English cố định. Thông số mới
    // (Configuration/Cost/Start Date/Place/Pool) không sort — BE chỉ whitelist code/type/status/assignee.
    const deviceCols: ColumnDef<AssetRow, unknown>[] = [
      {
        // Asset Type ở ĐẦU + là ô mở/đóng phần mềm (caret nằm trong ô này).
        id: 'type',
        accessorKey: 'type',
        header: t('assets.col.type'),
        cell: ({ row, table }) => (
          <TypeCell
            row={row.original}
            rowId={row.id}
            meta={table.options.meta as ExpandMeta<AssetRow> | undefined}
            softwareLabel={t('assets.kindSoftware')}
          />
        ),
      },
      {
        id: 'code',
        accessorKey: 'code',
        header: t('assets.col.code'),
        // Sổ tài sản có thể lẫn dòng phần mềm (không mã) → hiện Tên license thay mã.
        cell: ({ row }) => <CodeCell row={row.original} />,
      },
      {
        id: 'assignee',
        accessorKey: 'assignedUserName',
        header: t('assets.col.user'),
        cell: ({ row }) =>
          row.original.assignedUserName ?? row.original.assignedUserSub ?? '—',
      },
      {
        id: 'configuration',
        header: t('assets.col.configuration'),
        enableSorting: false,
        cell: ({ row }) => row.original.configuration ?? '—',
      },
      {
        id: 'cost',
        header: t('assets.col.cost'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.cost == null ? (
            '—'
          ) : (
            <span className="mono">{formatVnd(row.original.cost)}</span>
          ),
      },
      {
        id: 'startDate',
        header: t('assets.col.startDate'),
        enableSorting: false,
        cell: ({ row }) => row.original.startDate ?? '—',
      },
    ];
    // Kho thanh lý (hồ sơ đã chốt): thêm End Date để tra mốc hết hạn tại thời điểm thanh lý.
    if (disposedOnly) {
      deviceCols.push({
        id: 'endDate',
        header: t('assets.col.endDate'),
        enableSorting: false,
        cell: ({ row }) => row.original.endDate ?? '—',
      });
    }
    deviceCols.push({
      id: 'place',
      header: t('assets.col.place'),
      enableSorting: false,
      cell: ({ row }) => row.original.floor ?? '—',
    });
    deviceCols.push(statusCol);
    deviceCols.push(actionsCol);
    return deviceCols;
  }, [
    t,
    softwareOnly,
    disposedOnly,
    openEdit,
    copyFrom,
    handleDelete,
    onPurge,
    onDispose,
    setTransferSw,
    lifecycleActionsFor,
  ]);
}

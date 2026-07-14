import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ColumnDef } from '@tanstack/react-table';
import { RowActionsMenu } from './asset-row-actions';
import type { RowAction } from './asset-row-actions';
import { STATUS_BADGE, formatVnd } from './asset-types';
import type { AssetRow } from './asset-types';

const PAGE_SIZE = 20;

/**
 * Bộ cột DataTable của sổ tài sản. Tab Phần mềm (softwareOnly) và Sổ tài sản dùng bộ cột
 * KHÁC nhau (sw-license-model-redesign): phần mềm định danh bằng Tên license + Máy + Kỳ hạn;
 * máy có cột thông số English cố định + "Pool". Tách khỏi AssetsPage (§6) — chỉ dựng cột.
 */
export function useAssetColumns(opts: {
  page: number;
  softwareOnly: boolean;
  disposedOnly: boolean;
  openEdit: (id: string) => void | Promise<void>;
  copyFrom: (id: string) => void | Promise<void>;
  handleDelete: (row: AssetRow) => void | Promise<void>;
  handlePurge: (row: AssetRow) => void | Promise<void>;
  setTransferSw: (a: AssetRow) => void;
  lifecycleActionsFor: (a: AssetRow) => RowAction[];
}): ColumnDef<AssetRow, unknown>[] {
  const { t } = useTranslation();
  const {
    page,
    softwareOnly,
    disposedOnly,
    openEdit,
    copyFrom,
    handleDelete,
    handlePurge,
    setTransferSw,
    lifecycleActionsFor,
  } = opts;

  // id cột KHỚP whitelist BE (code/type/status/assignee) → map thẳng sang ?sort=.
  return useMemo<ColumnDef<AssetRow, unknown>[]>(() => {
    // No = STT liên tục theo trang (page-size 20) — chỉ hiển thị, không sort.
    const noCol: ColumnDef<AssetRow, unknown> = {
      id: 'no',
      header: t('assets.col.no', 'No'),
      enableSorting: false,
      cell: ({ row, table }) =>
        (page - 1) * PAGE_SIZE +
        table.getRowModel().rows.findIndex((r) => r.id === row.id) +
        1,
    };
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
                onClick: () => void handlePurge(a),
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
              {
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
        noCol,
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
          id: 'term',
          header: t('assets.termCol'),
          enableSorting: false,
          cell: ({ row }) =>
            row.original.licenseType === 'perpetual'
              ? t('assets.licensePerpetual')
              : (row.original.endDate ?? '—'),
        },
        statusCol,
        actionsCol,
      ];
    }
    // Bảng Tài sản (đại tu UAT): cột thông số theo tên English cố định. Thông số mới
    // (Configuration/Cost/Start Date/Place/Pool) không sort — BE chỉ whitelist code/type/status/assignee.
    return [
      noCol,
      {
        id: 'code',
        accessorKey: 'code',
        header: t('assets.col.code'),
        // Sổ tài sản có thể lẫn dòng phần mềm (không mã) → hiện Tên license thay mã.
        cell: ({ row }) =>
          row.original.code ? (
            <span className="mono">{row.original.code}</span>
          ) : (
            (row.original.licenseName ?? '—')
          ),
      },
      {
        id: 'assignee',
        accessorKey: 'assignedUserName',
        header: t('assets.col.user'),
        cell: ({ row }) =>
          row.original.assignedUserName ?? row.original.assignedUserSub ?? '—',
      },
      {
        id: 'type',
        accessorKey: 'type',
        header: t('assets.col.type'),
        cell: ({ row }) =>
          row.original.type === 'software'
            ? t('assets.kindSoftware')
            : row.original.type,
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
      {
        id: 'place',
        header: t('assets.col.place'),
        enableSorting: false,
        cell: ({ row }) => row.original.floor ?? '—',
      },
      statusCol,
      {
        id: 'pool',
        header: t('assets.col.pool'),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.isPool ? (
            <span className="badge ok plain">{t('assets.pool')}</span>
          ) : (
            <span className="muted">—</span>
          ),
      },
      actionsCol,
    ];
  }, [
    t,
    page,
    softwareOnly,
    disposedOnly,
    openEdit,
    copyFrom,
    handleDelete,
    handlePurge,
    setTransferSw,
    lifecycleActionsFor,
  ]);
}

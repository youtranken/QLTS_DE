import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
} from '@tanstack/react-table';

/** Trạng thái expand đưa xuống cột (qua table.meta) để ô đầu tự vẽ caret › như /phan-mem. */
export interface ExpandMeta<T> {
  expandedId: string | null;
  canExpandRow: (row: T) => boolean;
  toggleExpand: (id: string) => void;
}

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  emptyText: string;
  /** Có giá trị → hiện ô tìm kiếm toàn bảng (lọc client, debounce). */
  searchPlaceholder?: string;
  initialSort?: SortingState;
  /** Class cho từng <tr> theo dữ liệu dòng (vd dòng quá hạn tô đỏ). */
  rowClassName?: (row: T) => string;
  /** Class thêm cho <table> (giữ style riêng của trang, vd 'board-table'). */
  tableClassName?: string;
  /** Sort server-side: không sắp client, parent giữ `sorting` + refetch qua `onSortingChange`. */
  manualSorting?: boolean;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  /** Bấm cả dòng (vd mở chi tiết). Kèm bàn phím (Enter/Space) cho a11y. */
  onRowClick?: (row: T) => void;
  /**
   * Có giá trị → thêm cột ▸ để BUNG 1 hàng chi tiết in-context ngay dưới dòng
   * (trang Tài sản). Không truyền → bảng giữ nguyên như cũ (mọi trang khác).
   */
  renderExpanded?: (row: T) => ReactNode;
  /** Chỉ hiện mũi tên ▸ khi hàm này trả true (vd máy có phần mềm). Mặc định: mọi dòng. */
  canExpand?: (row: T) => boolean;
  /** ≤680px gập bảng thành thẻ dọc (mỗi ô 1 dòng có nhãn cột). */
  stackOnMobile?: boolean;
  /** Có giá trị → cột đầu (cùng ô ▸) hiện số thứ tự "#" = offset + vị trí + 1. Cần renderExpanded. */
  rowNumberOffset?: number;
  /** Chọn nhiều dòng (5.1): checkbox đầu dòng + chọn-tất-cả theo trang hiện tại. */
  selection?: {
    selected: Set<string>;
    onToggle: (id: string) => void;
    onToggleAll: (ids: string[], checked: boolean) => void;
  };
}

/**
 * Bảng dùng chung (design-system, review nguyên tắc #3): sort theo cột (asc→desc→bỏ),
 * search toàn bảng, trạng thái rỗng — headless TanStack Table, GIỮ nguyên CSS `.table`.
 * Thay các <table> tự viết không sort được ("0 bảng sort được" — review mục 5.1).
 */
export function DataTable<T>({
  data,
  columns,
  emptyText,
  searchPlaceholder,
  initialSort = [],
  rowClassName,
  tableClassName,
  manualSorting,
  sorting: controlledSorting,
  onSortingChange: controlledOnSortingChange,
  onRowClick,
  renderExpanded,
  canExpand,
  stackOnMobile,
  selection,
  rowNumberOffset,
}: DataTableProps<T>) {
  const [internalSort, setInternalSort] = useState<SortingState>(initialSort);
  const [globalFilter, setGlobalFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Controlled (server-side) nếu parent truyền sorting; ngược lại tự giữ state (client).
  const sorting = controlledSorting ?? internalSort;
  const onSortingChange = controlledOnSortingChange ?? setInternalSort;

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange,
    onGlobalFilterChange: setGlobalFilter,
    // asc-first nhất quán mọi cột (mặc định TanStack sort số theo desc-first — khó đoán cho user).
    sortDescFirst: false,
    globalFilterFn: 'includesString',
    manualSorting: manualSorting ?? false,
    // ID ổn định theo dữ liệu (không phải index): tránh hàng bung ▸ "dính" sai bản ghi
    // khi phân trang/sort/refetch thay đổi thứ tự (trang Tài sản dùng renderExpanded).
    getRowId: (row, index) => {
      const r = row as { id?: string | number };
      return r.id != null ? String(r.id) : String(index);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    // Cột đầu (Code) tự vẽ caret › mở/đóng như /phan-mem — đọc qua cell.table.options.meta.
    meta: {
      expandedId,
      canExpandRow: (r: T) => !!renderExpanded && (canExpand?.(r) ?? true),
      toggleExpand: (id: string) =>
        setExpandedId((cur) => (cur === id ? null : id)),
    } satisfies ExpandMeta<T>,
  });

  const rows = table.getRowModel().rows;
  // Dữ liệu đổi (sang trang/lọc) mà dòng đang bung không còn → thu gọn để không hiện nhầm.
  useEffect(() => {
    if (expandedId && !rows.some((r) => r.id === expandedId)) {
      setExpandedId(null);
    }
  }, [rows, expandedId]);

  return (
    <>
      {searchPlaceholder !== undefined && (
        <SearchBox onChange={setGlobalFilter} placeholder={searchPlaceholder} />
      )}
      <div className="table-wrap">
        <table
          className={[
            'table',
            tableClassName,
            stackOnMobile ? 'table-stack' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {selection && (
                  <th style={{ width: 34 }}>
                    <input
                      type="checkbox"
                      aria-label="Chọn tất cả"
                      checked={
                        rows.length > 0 &&
                        rows.every((r) => selection.selected.has(r.id))
                      }
                      onChange={(e) =>
                        selection.onToggleAll(
                          rows.map((r) => r.id),
                          e.target.checked,
                        )
                      }
                    />
                  </th>
                )}
                {renderExpanded && (
                  <th
                    className="lead-col"
                    aria-hidden={rowNumberOffset == null || undefined}
                    style={{ width: rowNumberOffset != null ? 56 : 34 }}
                  >
                    {rowNumberOffset != null ? '#' : null}
                  </th>
                )}
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : undefined
                      }
                    >
                      {h.isPlaceholder ? null : h.column.getCanSort() ? (
                        <button
                          type="button"
                          className="th-sort"
                          onClick={h.column.getToggleSortingHandler()}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          <span aria-hidden="true" className="sort-arrow">
                            {sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : ''}
                          </span>
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={
                    table.getAllLeafColumns().length +
                    (renderExpanded ? 1 : 0) +
                    (selection ? 1 : 0)
                  }
                  className="muted"
                >
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => {
                const rowCanExpand =
                  !!renderExpanded && (canExpand?.(row.original) ?? true);
                const expanded = rowCanExpand && expandedId === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={
                        [
                          onRowClick ? 'clickable' : '',
                          rowClassName?.(row.original) || '',
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      onClick={
                        onRowClick ? () => onRowClick(row.original) : undefined
                      }
                      onKeyDown={
                        onRowClick
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onRowClick(row.original);
                              }
                            }
                          : undefined
                      }
                      tabIndex={onRowClick ? 0 : undefined}
                      role={onRowClick ? 'button' : undefined}
                      style={onRowClick ? { cursor: 'pointer' } : undefined}
                    >
                      {selection && (
                        <td
                          className="sel"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label="Chọn dòng"
                            checked={selection.selected.has(row.id)}
                            onChange={() => selection.onToggle(row.id)}
                          />
                        </td>
                      )}
                      {renderExpanded && (
                        <td className="lead">
                          {rowNumberOffset != null && (
                            <span className="row-no">
                              {rowNumberOffset + rowIndex + 1}
                            </span>
                          )}
                        </td>
                      )}
                      {row.getVisibleCells().map((cell) => {
                        const h = cell.column.columnDef.header;
                        return (
                          <td
                            key={cell.id}
                            data-label={
                              typeof h === 'string' ? h : cell.column.id
                            }
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    {expanded && renderExpanded && (
                      <tr className="exp">
                        <td
                          colSpan={
                            row.getVisibleCells().length +
                            1 +
                            (selection ? 1 : 0)
                          }
                        >
                          {renderExpanded(row.original)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Ô search debounce 200ms — không lọc lại mỗi phím, giữ gõ mượt trên bảng lớn. */
function SearchBox({
  onChange,
  placeholder,
}: {
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    const id = setTimeout(() => onChange(text), 200);
    return () => clearTimeout(id);
  }, [text, onChange]);
  return (
    <input
      className="table-search"
      type="search"
      value={text}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setText(e.target.value)}
    />
  );
}

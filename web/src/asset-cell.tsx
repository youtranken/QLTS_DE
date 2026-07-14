import { AssetTypeIcon } from './asset-type-icon';
import type { ExpandMeta } from './ui/data-table';
import type { AssetRow } from './asset-types';

/**
 * Các ô "giàu" của bảng /tai-san (làm đẹp — không đổi dữ liệu). Tách khỏi assets-columns (§6):
 * Mã (mono + hãng + caret expand) và Loại (icon + nhãn). Chỉ dùng cho nhánh máy (device).
 */

/**
 * Mã (mono đậm) + dòng phụ Hãng + caret › ở ĐẦU ô (mở/đóng hàng phần mềm) như /phan-mem.
 * Caret đọc trạng thái expand qua `meta` (table.meta) — stopPropagation để không mở trang chi tiết.
 */
export function CodeCell({
  row,
  rowId,
  meta,
}: {
  row: AssetRow;
  rowId?: string;
  meta?: ExpandMeta<AssetRow>;
}) {
  const label = row.code ?? row.licenseName ?? '—';
  const canExpand = !!(rowId && meta?.canExpandRow(row));
  const open = !!(rowId && meta?.expandedId === rowId);
  return (
    <div className="cell-code">
      {canExpand ? (
        <button
          type="button"
          className={`cell-caret${open ? ' open' : ''}`}
          aria-expanded={open}
          aria-label={open ? 'Thu gọn' : 'Mở rộng'}
          onClick={(e) => {
            e.stopPropagation();
            meta?.toggleExpand(rowId!);
          }}
        >
          ›
        </button>
      ) : (
        <span className="cell-caret-spacer" aria-hidden="true" />
      )}
      <span className="cell-code-txt">
        {row.code ? (
          <span className="mono cell-code-id">{row.code}</span>
        ) : (
          <span>{label}</span>
        )}
        {row.brand && <span className="cell-sub">{row.brand}</span>}
      </span>
    </div>
  );
}

/** Loại: icon theo loại + nhãn (software → "Phần mềm"). Giữ nguyên chữ loại từ catalog. */
export function TypeCell({ row, softwareLabel }: { row: AssetRow; softwareLabel: string }) {
  return (
    <div className="cell-type">
      <AssetTypeIcon type={row.type} />
      <span>{row.type === 'software' ? softwareLabel : row.type}</span>
    </div>
  );
}

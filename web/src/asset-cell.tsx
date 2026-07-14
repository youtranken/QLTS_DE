import { AssetTypeIcon } from './asset-type-icon';
import type { ExpandMeta } from './ui/data-table';
import type { AssetRow } from './asset-types';

/**
 * Các ô "giàu" của bảng /tai-san (làm đẹp — không đổi dữ liệu). Tách khỏi assets-columns (§6):
 * Loại (ô ĐẦU: caret expand + icon + nhãn, bấm cả ô để mở/đóng phần mềm) và Mã (mono + hãng).
 * Chỉ dùng cho nhánh máy (device).
 */

/**
 * Loại (ô đầu tiên): caret › + icon + nhãn (software → "Phần mềm"). Khi máy CÓ phần mềm cài
 * (canExpand) → cả ô là nút mở/đóng hàng phần mềm; stopPropagation để không mở trang chi tiết.
 * Không có phần mềm → ô tĩnh, click rơi xuống row (mở trang chi tiết).
 */
export function TypeCell({
  row,
  rowId,
  meta,
  softwareLabel,
}: {
  row: AssetRow;
  rowId?: string;
  meta?: ExpandMeta<AssetRow>;
  softwareLabel: string;
}) {
  const canExpand = !!(rowId && meta?.canExpandRow(row));
  const open = !!(rowId && meta?.expandedId === rowId);
  const body = (
    <>
      {canExpand ? (
        <span className={`cell-caret${open ? ' open' : ''}`} aria-hidden="true">
          ›
        </span>
      ) : (
        <span className="cell-caret-spacer" aria-hidden="true" />
      )}
      <span className="cell-type-main">
        <AssetTypeIcon type={row.type} />
        <span>{row.type === 'software' ? softwareLabel : row.type}</span>
      </span>
    </>
  );
  if (canExpand) {
    return (
      <button
        type="button"
        className={`cell-type cell-type-btn${open ? ' open' : ''}`}
        aria-expanded={open}
        aria-label={open ? 'Thu gọn' : 'Mở rộng'}
        onClick={(e) => {
          e.stopPropagation();
          meta?.toggleExpand(rowId!);
        }}
      >
        {body}
      </button>
    );
  }
  return <div className="cell-type">{body}</div>;
}

/** Mã (mono đậm) + dòng phụ Hãng. Caret expand nằm ở ô Loại (ô đầu) nên ô Mã chỉ còn nội dung. */
export function CodeCell({ row }: { row: AssetRow }) {
  const label = row.code ?? row.licenseName ?? '—';
  return (
    <span className="cell-code-txt">
      {row.code ? (
        <span className="mono cell-code-id">{row.code}</span>
      ) : (
        <span>{label}</span>
      )}
      {row.brand && <span className="cell-sub">{row.brand}</span>}
    </span>
  );
}

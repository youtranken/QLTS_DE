import { useTranslation } from 'react-i18next';

/**
 * Hợp đồng loading/empty/error dùng chung (review nguyên tắc #8): mọi màn fetch phải PHÂN BIỆT
 * "đang tải" ≠ "rỗng" ≠ "lỗi". Trước đây nhiều màn nuốt lỗi thành 0 hoặc kẹt "…" vô hạn (P0).
 * (fetchJson tách sang ./fetch-json để file này chỉ export component — fast-refresh.)
 */

/**
 * Empty-state dùng chung: icon + tiêu đề + gợi ý + (tùy) nút hành động. Thay cho
 * `<p className="empty">` khi muốn hướng người dùng bước tiếp (giảm cảm giác "trống trơn").
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span>{title}</span>
      {hint && <span className="empty-hint">{hint}</span>}
      {action && <span className="empty-action">{action}</span>}
    </div>
  );
}

/** Khối "không tải được + Thử lại" dùng chung khi một màn fetch thất bại. */
export function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="load-error" style={{ padding: '1rem 0' }}>
      <p style={{ color: 'var(--danger)', marginBottom: '.5rem' }}>
        {t('app.loadError')}
      </p>
      <button type="button" className="primary sm" onClick={onRetry}>
        {t('app.retry')}
      </button>
    </div>
  );
}

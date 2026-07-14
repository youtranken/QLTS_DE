import { useTranslation } from 'react-i18next';
import { DatePicker } from './ui/date-picker';

/**
 * Thanh lọc sổ tài sản: tìm kiếm + Loại + Trạng thái + khoảng ngày hết hạn + chip "sắp hết hạn"
 * + nút xóa lọc. Thuần trình bày — state do AssetsPage giữ. Mỗi thay đổi reset về trang 1.
 */
export interface AssetsFilterBarProps {
  softwareOnly: boolean;
  disposedOnly: boolean;
  searchInput: string;
  setSearchInput: (v: string) => void;
  type: string;
  setType: (v: string) => void;
  types: string[];
  status: string;
  setStatus: (v: string) => void;
  endFrom: string;
  setEndFrom: (v: string) => void;
  endTo: string;
  setEndTo: (v: string) => void;
  expiring: boolean;
  setExpiring: (v: boolean) => void;
  hasFilter: boolean;
  setPage: (p: number) => void;
  onClearAll: () => void;
}

export function AssetsFilterBar({
  softwareOnly,
  disposedOnly,
  searchInput,
  setSearchInput,
  type,
  setType,
  types,
  status,
  setStatus,
  endFrom,
  setEndFrom,
  endTo,
  setEndTo,
  expiring,
  setExpiring,
  hasFilter,
  setPage,
  onClearAll,
}: AssetsFilterBarProps) {
  const { t } = useTranslation();
  return (
    <div className="filter-bar">
      <input
        className="grow search"
        placeholder={t('assets.searchPlaceholder')}
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />
      {!softwareOnly && (
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('assets.filterType')}</option>
          {/* Sổ tài sản không hiện phần mềm → bỏ 'software' khỏi bộ lọc Loại. */}
          {types
            .filter((v) => v !== 'software')
            .map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
        </select>
      )}
      {!disposedOnly && (
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('assets.filterStatus')}</option>
          {['in_use', 'locked_repair', 'disposed'].map((v) => (
            <option key={v} value={v}>
              {t(`assets.status.${v}`)}
            </option>
          ))}
        </select>
      )}
      {/* Theo dõi hạn: lọc end_date theo khoảng ngày tự chọn (cả sổ tài sản & phần mềm). */}
      <label className="field-inline">
        <span className="muted">{t('assets.endFrom', 'Hết hạn từ')}</span>
        <DatePicker
          value={endFrom}
          max={endTo || undefined}
          ariaLabel={t('assets.endFrom', 'Hết hạn từ')}
          onChange={(v) => {
            setEndFrom(v);
            setPage(1);
          }}
        />
      </label>
      <label className="field-inline">
        <span className="muted">{t('assets.endTo', 'đến')}</span>
        <DatePicker
          value={endTo}
          min={endFrom || undefined}
          ariaLabel={t('assets.endTo', 'đến')}
          onChange={(v) => {
            setEndTo(v);
            setPage(1);
          }}
        />
      </label>
      {expiring && (
        <span className="chip">
          {t('assets.expiringFilter')}
          <button
            type="button"
            aria-label={t('assets.clearFilters')}
            onClick={() => {
              setExpiring(false);
              setPage(1);
            }}
          >
            ✕
          </button>
        </span>
      )}
      {hasFilter && (
        <button type="button" onClick={onClearAll}>
          {t('assets.clearFilters')}
        </button>
      )}
    </div>
  );
}

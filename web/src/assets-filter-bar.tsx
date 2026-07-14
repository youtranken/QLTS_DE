import { useTranslation } from 'react-i18next';
import { DatePicker } from './ui/date-picker';
import { formatDmy } from './asset-types';

/**
 * Thanh lọc sổ tài sản: tìm kiếm + Loại + Trạng thái + khoảng ngày hết hạn + chip "sắp hết hạn"
 * + nút xóa lọc. Thuần trình bày — state do AssetsPage giữ. Mỗi thay đổi reset về trang 1.
 * Dưới thanh lọc: hàng chip lọc ĐANG BẬT (gỡ từng điều kiện, khớp caret › thống nhất).
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

  // Chip lọc đang bật: mỗi điều kiện (trừ ô tìm kiếm — đã hiện trong input) là 1 chip gỡ được.
  const chips: { key: string; label: string; value: string; onRemove: () => void }[] = [];
  if (type) {
    chips.push({
      key: 'type',
      label: t('assets.type'),
      value: type,
      onRemove: () => {
        setType('');
        setPage(1);
      },
    });
  }
  if (status) {
    chips.push({
      key: 'status',
      label: t('assets.statusLabel'),
      value: t(`assets.status.${status}`),
      onRemove: () => {
        setStatus('');
        setPage(1);
      },
    });
  }
  if (expiring) {
    chips.push({
      key: 'expiring',
      label: '',
      value: t('assets.expiringFilter'),
      onRemove: () => {
        setExpiring(false);
        setPage(1);
      },
    });
  }
  if (endFrom || endTo) {
    chips.push({
      key: 'date',
      label: t('assets.endDate'),
      value: `${endFrom ? formatDmy(endFrom) : '…'} → ${endTo ? formatDmy(endTo) : '…'}`,
      onRemove: () => {
        setEndFrom('');
        setEndTo('');
        setPage(1);
      },
    });
  }

  return (
    <>
      <div className="filter-bar">
        <input
          className="grow search"
          placeholder={t('assets.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {!softwareOnly && (
          <select
            aria-label={t('assets.type')}
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
            aria-label={t('assets.statusLabel')}
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
        {hasFilter && (
          <button type="button" onClick={onClearAll}>
            {t('assets.clearFilters')}
          </button>
        )}
      </div>
      {chips.length > 0 && (
        <div className="active-filters">
          <span className="af-label">{t('assets.activeFilters', 'Đang lọc')}</span>
          {chips.map((c) => (
            <span key={c.key} className="chip filter-chip">
              {c.label && <b>{c.label}:</b>}
              {c.value}
              <button
                type="button"
                aria-label={t('assets.clearFilters')}
                onClick={c.onRemove}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

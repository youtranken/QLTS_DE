import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CATALOG_CAP,
  type FreePoolMachine,
  type SlotInfo,
} from './board-types';

/**
 * Catalog "Máy có thể mượn" (9.5+) — pool đang rảnh dạng card grid, máy-first: tìm/lọc loại,
 * xem giờ trống ngày làm gần nhất, và Đặt. Tách khỏi BorrowBoardPage (§6). State lọc catalog
 * cục bộ ở đây; state giờ-trống (slots) do trang cha giữ (cần xoá cache khi có đặt mới).
 */
export function BoardCatalog({
  free,
  openBooking,
  slotMachine,
  slots,
  slotsLoading,
  toggleSlots,
}: {
  free: FreePoolMachine[];
  openBooking: (machine?: FreePoolMachine) => void;
  slotMachine: string | null;
  slots: SlotInfo | null;
  slotsLoading: boolean;
  toggleSlots: (id: string) => void | Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  // 9.5+: catalog máy-first — search client-side + lọc theo loại (distinct từ pool rảnh).
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogType, setCatalogType] = useState('all');
  // #1: nhiều máy → chỉ hiện CATALOG_CAP thẻ đầu, còn lại bung khi bấm "Xem tất cả".
  const [showAllCatalog, setShowAllCatalog] = useState(false);

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

  // Nhãn ngày cho khối "giờ trống": Hôm nay / Ngày mai / thứ+ngày (khi phải nhảy ngày).
  const slotDayLabel = (off: number): string => {
    if (off <= 0) return t('board.today', 'Hôm nay');
    if (off === 1) return t('board.tomorrow', 'Ngày mai');
    const d = new Date();
    d.setDate(d.getDate() + off);
    return d.toLocaleDateString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    });
  };

  if (free.length === 0) return null;
  return (
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
        <>
          <div className="mcatalog dense">
            {(showAllCatalog
              ? freeFiltered
              : freeFiltered.slice(0, CATALOG_CAP)
            ).map((m) => {
              const busy = m.busyUntil != null;
              const slotsOpen = slotMachine === m.id;
              return (
                <div key={m.id} className="mcard mcard-sm">
                  <div className="mc-head">
                    <span className="mc-code">{m.code}</span>
                    {busy ? (
                      <span className="avail busy">
                        {t('board.catalogBusyShort', 'Bận')}
                      </span>
                    ) : (
                      <span className="avail free">
                        {t('board.catalogFree', 'Rảnh ngay')}
                      </span>
                    )}
                  </div>
                  <div className="mc-spec">
                    {m.type}
                    {m.configuration ? ` · ${m.configuration}` : ''}
                    {busy && (
                      <span className="muted">
                        {' · '}
                        {t('board.catalogBusyUntil', 'Bận đến {{time}}', {
                          time: fmt(m.busyUntil ?? null),
                        })}
                      </span>
                    )}
                  </div>
                  <div className="mc-actions">
                    {!busy && (
                      <button
                        type="button"
                        className="ghost sm"
                        aria-expanded={slotsOpen}
                        onClick={() => void toggleSlots(m.id)}
                      >
                        {slotsOpen
                          ? t('board.hideSlots', 'Ẩn giờ')
                          : t('board.showSlots', 'Giờ trống ▾')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={busy ? 'sm' : 'primary sm'}
                      onClick={() => openBooking(m)}
                    >
                      {busy
                        ? t('board.catalogSchedule', 'Đặt lịch')
                        : t('board.catalogBook', 'Đặt')}
                    </button>
                  </div>
                  {slotsOpen && (
                    <div className="slot-row">
                      {slotsLoading ? (
                        <span className="muted">…</span>
                      ) : slots && slots.slots.length > 0 ? (
                        <>
                          <span className="slot-day">
                            {slotDayLabel(slots.dayOffset)}
                          </span>
                          {slots.slots.map((s) => (
                            <button
                              key={s}
                              type="button"
                              className="slotchip"
                              onClick={() => openBooking(m)}
                              title={t('board.bookAt', 'Đặt máy này lúc {{s}}', {
                                s,
                              })}
                            >
                              {s}
                            </button>
                          ))}
                        </>
                      ) : (
                        <span className="muted" style={{ fontSize: '0.8rem' }}>
                          {t(
                            'board.noSlotsWeek',
                            'Kín lịch tuần này — bấm Đặt để chọn ngày khác',
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {freeFiltered.length > CATALOG_CAP && (
            <button
              type="button"
              className="ghost sm"
              style={{ marginTop: '0.5rem' }}
              onClick={() => setShowAllCatalog((v) => !v)}
            >
              {showAllCatalog
                ? t('board.catalogCollapse', 'Thu gọn')
                : t('board.catalogShowAll', 'Xem tất cả ({{n}}) →', {
                    n: freeFiltered.length,
                  })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

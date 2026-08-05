import { useTranslation } from 'react-i18next';
import { DatePicker } from '@/ui/date-picker';
import { TimeField } from '@/ui/time-field';
import { PICKUP_SLOTS, nowTimeLocal, todayLocal } from '@/features/booking/booking-types';

/**
 * Khối chọn THỜI GIAN của popup Đặt máy (Thường/Nâng cao): 4 ô Ngày/Giờ nhận-trả,
 * chip gợi ý giờ, và các cảnh báo (CN / thứ tự giờ / cần Nâng cao / máy bận / policy duyệt).
 * Thuần trình bày — mọi state do BookingSheet giữ, truyền xuống qua props.
 */
export interface BookingTimeFieldsProps {
  fromDate: string;
  fromTime: string;
  toDate: string;
  toTime: string;
  setFromDate: (v: string) => void;
  setFromTime: (v: string) => void;
  setToDate: (v: string) => void;
  setToTime: (v: string) => void;
  slotTarget: 'from' | 'to';
  setSlotTarget: (v: 'from' | 'to') => void;
  weekendBlocked: boolean;
  invalidRange: boolean;
  longBlocked: boolean;
  isLong: boolean;
  selectedBusy: boolean;
  assetId: string;
  from: string;
  to: string;
  /** Thường (≤2 ngày): giới hạn ngày trả tối đa = nhận + 2 (chuỗi YYYY-MM-DD). Nâng cao: undefined. */
  returnMax?: string;
  /** Thường: mốc trả tối đa = nhận + 48h (epoch ms) → khóa chip giờ trả vượt ngưỡng. */
  returnCapMs?: number;
  /** Ngày làm việc config (ISO 1=T2..7=CN) — khóa ngày ngoài set trên lịch (audit H3). */
  bookableDays?: number[];
  /** Ngày máy đã bận (YYYY-MM-DD) — khóa trên DatePicker để không chọn trùng đặt máy. */
  busyDates?: Set<string>;
}

export function BookingTimeFields({
  fromDate,
  fromTime,
  toDate,
  toTime,
  setFromDate,
  setFromTime,
  setToDate,
  setToTime,
  slotTarget,
  setSlotTarget,
  weekendBlocked,
  invalidRange,
  longBlocked,
  isLong,
  selectedBusy,
  assetId,
  from,
  to,
  returnMax,
  returnCapMs,
  bookableDays,
  busyDates,
}: BookingTimeFieldsProps) {
  const { t } = useTranslation();
  const busyDate = busyDates
    ? (iso: string) => busyDates.has(iso)
    : undefined;
  return (
    <>
      <div
        className="form-grid"
        style={{
          marginBottom: '0.75rem',
          // Ép 2 cột → mỗi hàng một cặp: Nhận (Ngày|Giờ), Trả (Ngày|Giờ)
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        }}
      >
        <label className="field">
          <span>{t('bookingSheet.pickupDate')}</span>
          <DatePicker
            min={todayLocal()}
            value={fromDate}
            clearable={false}
            bookableDays={bookableDays}
            busyDate={busyDate}
            ariaLabel={t('bookingSheet.pickupDate')}
            onChange={setFromDate}
          />
        </label>
        <label className="field">
          <span>{t('bookingSheet.pickupTime')}</span>
          <TimeField
            value={fromTime}
            ariaLabel={t('bookingSheet.pickupTime')}
            onFocus={() => setSlotTarget('from')}
            onChange={setFromTime}
          />
        </label>
        <label className="field">
          <span>{t('bookingSheet.returnDate')}</span>
          <DatePicker
            min={fromDate || todayLocal()}
            max={returnMax}
            value={toDate}
            clearable={false}
            bookableDays={bookableDays}
            busyDate={busyDate}
            ariaLabel={t('bookingSheet.returnDate')}
            onChange={setToDate}
          />
        </label>
        <label className="field">
          <span>{t('bookingSheet.returnTime')}</span>
          <TimeField
            value={toTime}
            ariaLabel={t('bookingSheet.returnTime')}
            onFocus={() => setSlotTarget('to')}
            onChange={setToTime}
          />
        </label>
      </div>
      {/* Chip giờ gợi ý: áp vào ô ĐANG chọn (nhận/trả). 7 chip nhỏ gọn trên 1 hàng. */}
      <div className="slot-suggest">
        <span className="slot-suggest-label">
          {slotTarget === 'from'
            ? t('bookingSheet.suggestFrom', 'Gợi ý giờ nhận')
            : t('bookingSheet.suggestTo', 'Gợi ý giờ trả')}
        </span>
        <div className="slot-suggest-chips">
          {(() => {
            // Hiện ĐỦ khung giờ nhưng KHÓA (disabled) giờ đã qua thay vì ẩn:
            // - hôm nay: giờ < giờ hiện tại → khóa;
            // - giờ trả cùng ngày nhận: ≤ giờ nhận đã chọn → khóa.
            // Nhãn hiển thị 12h + gom nhóm AM/PM (khớp TimePicker); state vẫn giữ 'HH:MM' 24h.
            const activeDate = slotTarget === 'from' ? fromDate : toDate;
            const isToday = activeDate === todayLocal();
            const nowT = nowTimeLocal();
            const chips = PICKUP_SLOTS.map((s) => {
              const H = Number(s.slice(0, 2));
              return {
                s,
                pm: H >= 12,
                label: `${((H + 11) % 12) + 1}:${s.slice(3)}`,
                locked:
                  (isToday && s < nowT) ||
                  (slotTarget === 'to' &&
                    toDate === fromDate &&
                    !!fromTime &&
                    s <= fromTime) ||
                  // Thường: khóa giờ trả làm tổng vượt 48h so với giờ nhận.
                  (slotTarget === 'to' &&
                    returnCapMs != null &&
                    !!toDate &&
                    new Date(`${toDate}T${s}`).getTime() > returnCapMs),
              };
            });
            if (chips.every((c) => c.locked)) {
              return (
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  {t('bookingSheet.noSlotToday', 'Hết giờ gợi ý — chọn ngày khác.')}
                </span>
              );
            }
            const cur = slotTarget === 'from' ? fromTime : toTime;
            const chipBtn = (c: (typeof chips)[number]) => (
              <button
                key={c.s}
                type="button"
                disabled={c.locked}
                className={`slot-pick${cur === c.s ? ' on' : ''}${c.locked ? ' off' : ''}`}
                onClick={() =>
                  slotTarget === 'from' ? setFromTime(c.s) : setToTime(c.s)
                }
              >
                {c.label}
              </button>
            );
            const am = chips.filter((c) => !c.pm);
            const pm = chips.filter((c) => c.pm);
            const group = (list: typeof chips, lbl: string) =>
              list.length > 0 ? (
                <div className="slot-group">
                  {list.map(chipBtn)}
                  <span className="slot-mer-lbl">{lbl}</span>
                </div>
              ) : null;
            return (
              <>
                {group(am, 'AM')}
                {group(pm, 'PM')}
              </>
            );
          })()}
        </div>
      </div>
      {weekendBlocked && (
        <p className="alert warn">{t('bookingSheet.errWeekend')}</p>
      )}
      {invalidRange && (
        <p className="alert warn">
          {t('bookingSheet.errOrder', 'Giờ trả phải sau giờ nhận.')}
        </p>
      )}
      {longBlocked && (
        <p className="alert warn">{t('bookingSheet.needAdvanced')}</p>
      )}

      {selectedBusy && (
        <p className="alert warn">
          {t(
            'bookingSheet.presetBusy',
            'Máy này đã bận ở khung giờ vừa chọn — vui lòng đổi máy khác.',
          )}
        </p>
      )}

      {/* #3: báo policy duyệt theo thời lượng (≤2 ngày tự duyệt / >2 ngày Admin). */}
      {assetId && from && to && !weekendBlocked && !invalidRange && (
        <p
          style={{
            marginTop: '0.7rem',
            marginBottom: 0,
            fontWeight: 600,
            fontSize: '0.85rem',
            color: isLong ? 'var(--warn)' : 'var(--ok)',
          }}
        >
          {isLong
            ? `⏳ ${t('bookingSheet.hintAdmin', 'Mượn hơn 2 ngày — cần Admin duyệt trước khi nhận.')}`
            : `✔ ${t('bookingSheet.hintAuto', 'Mượn ≤ 2 ngày — tự duyệt, nhận ngay.')}`}
        </p>
      )}
    </>
  );
}

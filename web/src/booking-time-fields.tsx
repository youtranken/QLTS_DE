import { useTranslation } from 'react-i18next';
import { DatePicker } from './ui/date-picker';
import {
  PICKUP_SLOTS,
  WORK_END,
  WORK_START,
  nowTimeLocal,
  todayLocal,
} from './booking-types';

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
}: BookingTimeFieldsProps) {
  const { t } = useTranslation();
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
            ariaLabel={t('bookingSheet.pickupDate')}
            onChange={setFromDate}
          />
        </label>
        <label className="field">
          <span>{t('bookingSheet.pickupTime')}</span>
          <input
            type="time"
            min={
              fromDate === todayLocal()
                ? nowTimeLocal() > WORK_START
                  ? nowTimeLocal()
                  : WORK_START
                : WORK_START
            }
            max={WORK_END}
            value={fromTime}
            onFocus={() => setSlotTarget('from')}
            onChange={(e) => setFromTime(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('bookingSheet.returnDate')}</span>
          <DatePicker
            min={fromDate || todayLocal()}
            value={toDate}
            clearable={false}
            ariaLabel={t('bookingSheet.returnDate')}
            onChange={setToDate}
          />
        </label>
        <label className="field">
          <span>{t('bookingSheet.returnTime')}</span>
          <input
            type="time"
            min={toDate === fromDate && fromTime ? fromTime : WORK_START}
            max={WORK_END}
            value={toTime}
            onFocus={() => setSlotTarget('to')}
            onChange={(e) => setToTime(e.target.value)}
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
            // Hôm nay: chỉ gợi ý giờ SAU giờ hiện tại (13:30 → ẩn 08–13, còn 14,15).
            // Giờ trả cùng ngày nhận: phải sau giờ nhận đã chọn.
            const activeDate = slotTarget === 'from' ? fromDate : toDate;
            const isToday = activeDate === todayLocal();
            const nowT = nowTimeLocal();
            const chips = PICKUP_SLOTS.filter((s) => {
              if (isToday && s < nowT) return false;
              if (
                slotTarget === 'to' &&
                toDate === fromDate &&
                fromTime &&
                s <= fromTime
              )
                return false;
              return true;
            });
            if (chips.length === 0) {
              return (
                <span className="muted" style={{ fontSize: '0.82rem' }}>
                  {t('bookingSheet.noSlotToday', 'Hết giờ gợi ý — chọn ngày khác.')}
                </span>
              );
            }
            const cur = slotTarget === 'from' ? fromTime : toTime;
            return chips.map((s) => (
              <button
                key={s}
                type="button"
                className={`slot-pick${cur === s ? ' on' : ''}`}
                onClick={() =>
                  slotTarget === 'from' ? setFromTime(s) : setToTime(s)
                }
              >
                {s}
              </button>
            ));
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
            'Máy này đã bận ở khung giờ vừa chọn — đổi khung hoặc đổi máy.',
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

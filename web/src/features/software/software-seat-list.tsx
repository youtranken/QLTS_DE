import { useTranslation } from 'react-i18next';
import { RowActionsMenu } from '@/features/assets/asset-row-actions';
import {
  STATUS_BADGE,
  formatVnd,
  formatDmy,
  daysUntil,
  EXPIRY_SOON_DAYS,
} from '@/lib/asset-types';
import type { AssetRow } from '@/lib/asset-types';

/**
 * Hàng bung của 1 license ở /phan-mem: MỘT lưới căn cột Code/User/Cost/Start/End/Note + ⋯.
 * Bản đã gắn: ⋯ = Sửa/Gỡ/Thanh lý. Ghế trống (Code/User trống, các cột khác vẫn có vì nhập
 * lúc tạo): ⋯ = Gắn máy/Sửa/Thanh lý. Click 1 bản → xem read-only. Người giữ derive theo máy.
 */
export function SoftwareSeatList({
  seats,
  onView,
  onEdit,
  onDetach,
  onDispose,
  onAssign,
}: {
  seats: AssetRow[];
  onView: (s: AssetRow) => void;
  onEdit: (s: AssetRow) => void;
  onDetach: (s: AssetRow) => void;
  onDispose: (s: AssetRow) => void;
  onAssign: (s: AssetRow) => void;
}) {
  const { t } = useTranslation();
  const live = seats.filter((s) => s.status !== 'disposed');
  // Đã gắn máy lên trước, ghế trống xuống dưới.
  const rows = [...live].sort(
    (a, b) => (a.installedOnCode ? 0 : 1) - (b.installedOnCode ? 0 : 1),
  );
  const usedCount = live.filter((s) => s.installedOnCode).length;

  // End Date: dd/mm/yyyy; term sắp hết hạn (≤30 ngày) hoặc quá hạn → đỏ nhấp nháy + đếm ngược.
  const endNode = (s: AssetRow) => {
    if (s.licenseType === 'perpetual') return t('assets.licensePerpetual');
    if (!s.endDate) return '—';
    // Chỉ 'term' mới cảnh báo hạn — bản không rõ loại (licenseType null) chỉ hiện ngày, không blink.
    const n = s.licenseType === 'term' ? daysUntil(s.endDate) : NaN;
    if (Number.isFinite(n) && n <= EXPIRY_SOON_DAYS) {
      const label =
        n < 0
          ? t('software.overdueDays', { n: Math.abs(n), defaultValue: 'quá hạn {{n}} ngày' })
          : t('software.daysLeft', { n, defaultValue: 'còn {{n}} ngày' });
      return (
        <span className="seat-due due-over">
          <span>{formatDmy(s.endDate)}</span>
          <small>{label}</small>
        </span>
      );
    }
    return formatDmy(s.endDate);
  };

  const actionsFor = (s: AssetRow) =>
    s.installedOnCode
      ? [
          { label: t('assets.edit'), icon: 'edit' as const, onClick: () => onEdit(s) },
          {
            label: t('software.detach', 'Gỡ'),
            icon: 'detach' as const,
            onClick: () => onDetach(s),
          },
          {
            label: t('assets.disposeAction', 'Thanh lý'),
            icon: 'dispose' as const,
            danger: true,
            onClick: () => onDispose(s),
          },
        ]
      : [
          {
            label: t('software.assignMachine'),
            icon: 'link' as const,
            onClick: () => onAssign(s),
          },
          { label: t('assets.edit'), icon: 'edit' as const, onClick: () => onEdit(s) },
          {
            label: t('assets.disposeAction', 'Thanh lý'),
            icon: 'dispose' as const,
            danger: true,
            onClick: () => onDispose(s),
          },
        ];

  return (
    <>
      <div className="sw-detail-head">
        {t('software.seatsHeader', {
          used: usedCount,
          total: live.length,
          defaultValue: '{{used}}/{{total}} ghế đã gắn',
        })}
      </div>
      {live.length === 0 ? (
        <div className="sw-detail-empty">
          {t('software.notInstalled', 'Chưa cài trên máy nào.')}
        </div>
      ) : (
        <div className="seat-list">
          <div className="seat-hd">
            <span>{t('assets.col.code')}</span>
            <span>{t('assets.col.user')}</span>
            <span>{t('assets.col.cost')}</span>
            <span>{t('assets.col.startDate')}</span>
            <span>{t('assets.col.endDate')}</span>
            <span>{t('assets.contract', 'Contract')}</span>
            <span>{t('assets.col.note')}</span>
            <span aria-hidden="true" />
          </div>
          {rows.map((s) => {
            const free = !s.installedOnCode;
            return (
              <div
                key={s.id}
                className={`seat-card clickable${free ? ' seat-free' : ''}`}
                onClick={() => onView(s)}
              >
                <div className="seat-mc">
                  {free ? (
                    <span className="muted">{t('software.seatFree', 'Ghế trống')}</span>
                  ) : (
                    <>
                      <span className="mono">{s.installedOnCode}</span>
                      {s.status && s.status !== 'in_use' && (
                        <span className={`badge ${STATUS_BADGE[s.status] ?? 'muted'}`}>
                          {t(`assets.status.${s.status}`)}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="seat-who">
                  {s.assignedUserName ?? s.assignedUserSub ?? (
                    <span className="muted">—</span>
                  )}
                </div>
                <div className="seat-cost">
                  {s.cost == null ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className="mono">{formatVnd(s.cost)}</span>
                  )}
                </div>
                <div className="seat-date">{formatDmy(s.startDate)}</div>
                <div className="seat-date">{endNode(s)}</div>
                <div className="seat-note">
                  {s.contract ? (
                    <span title={s.contract}>{s.contract}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
                <div className="seat-note">
                  {s.note ? (
                    <span title={s.note}>{s.note}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
                <div className="seat-menu" onClick={(e) => e.stopPropagation()}>
                  {/* Đã gắn máy → nút "Chuyển" hiện thẳng kế ⋯ (thay vì nằm trong menu) — chuyển
                      seat sang máy khác nhanh, dùng lại SoftwareTransferDialog qua onAssign. */}
                  {!free && (
                    <button
                      type="button"
                      className="sm transfer-btn"
                      onClick={() => onAssign(s)}
                    >
                      ⇄ {t('assets.transferAction')}
                    </button>
                  )}
                  <RowActionsMenu actions={actionsFor(s)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

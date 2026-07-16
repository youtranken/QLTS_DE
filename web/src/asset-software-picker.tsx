import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import { formatDmy } from './asset-types';
import type { AssetRow } from './asset-types';

export interface InstalledSoftwareRow {
  id: string;
  code: string | null;
  licenseType: string | null;
  licenseName: string | null;
  startDate?: string | null;
  endDate: string | null;
  brand?: string | null;
  note?: string | null;
}

/**
 * Khối "Software đã cài" của MÁY, tách khỏi asset-form (§6). Bảng phần mềm đã gắn + ô search (+).
 * - isCreate=true: chọn phần mềm gắn SAU khi tạo máy (pendingSw, gỡ = bỏ khỏi danh sách).
 * - isCreate=false: máy đã tồn tại → phần mềm đang cài + gắn/gỡ ngay (moveSoftware).
 * Trình bày thuần: state + handler vẫn ở asset-form.
 */
export function AssetSoftwarePicker({
  isCreate,
  busy,
  swQuery,
  setSwQuery,
  swOptions,
  pendingSw,
  setPendingSw,
  installedSoftware,
  moveSoftware,
  machineId,
}: {
  isCreate: boolean;
  busy: boolean;
  swQuery: string;
  setSwQuery: (v: string) => void;
  swOptions: AssetRow[];
  pendingSw: AssetRow[];
  setPendingSw: Dispatch<SetStateAction<AssetRow[]>>;
  installedSoftware: InstalledSoftwareRow[];
  moveSoftware: (swId: string, target: string | null) => void;
  machineId: string | null;
}) {
  const { t } = useTranslation();

  // Chuẩn hóa về cùng shape để render bảng chung cho cả create (pendingSw) và edit (installed).
  const rows: InstalledSoftwareRow[] = isCreate
    ? pendingSw.map((s) => ({
        id: s.id,
        code: s.code,
        licenseType: s.licenseType ?? null,
        licenseName: s.licenseName ?? null,
        startDate: s.startDate ?? null,
        endDate: s.endDate ?? null,
        brand: s.brand ?? null,
        note: s.note ?? null,
      }))
    : installedSoftware;

  const remove = (id: string) => {
    if (isCreate) setPendingSw((prev) => prev.filter((x) => x.id !== id));
    else void moveSoftware(id, null);
  };

  // Khi TẠO máy chỉ gợi ý ghế license TRỐNG (chưa gắn máy nào) và chưa nằm trong danh sách
  // đang chọn — ghế đang dùng ở máy khác không gắn kèm lúc tạo. Edit gắn thẳng (cho chuyển ghế).
  const options = isCreate
    ? swOptions.filter(
        (o) => !o.installedOnCode && !pendingSw.some((p) => p.id === o.id),
      )
    : swOptions;

  return (
    <div className="form-section">
      <div className="form-section-title">{t('assets.installedSoftware')}</div>

      {rows.length === 0 ? (
        <p className="muted" style={{ margin: '0 0 0.6rem' }}>
          {t('assets.installedSoftwareNone')}
        </p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: '0.6rem' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('assets.licenseName')}</th>
                <th>{t('assets.licenseType')}</th>
                <th>{t('assets.startDate')}</th>
                <th>{t('assets.endDate')}</th>
                <th>{t('assets.note')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.licenseName ?? <span className="mono">{s.code}</span>}
                  </td>
                  <td>
                    {s.licenseType === 'term'
                      ? t('assets.licenseTerm')
                      : s.licenseType === 'perpetual'
                        ? t('assets.licensePerpetual')
                        : '—'}
                  </td>
                  <td>{s.startDate ?? '—'}</td>
                  <td>
                    {s.licenseType === 'perpetual'
                      ? t('assets.licensePerpetual')
                      : (s.endDate ?? '—')}
                  </td>
                  <td>{s.note ?? '—'}</td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="ghost sm"
                      disabled={busy}
                      onClick={() => remove(s.id)}
                    >
                      {t('assets.detachSoftware')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Combobox
        placeholder={t('assets.attachSoftwareSearch')}
        query={swQuery}
        onQuery={setSwQuery}
        options={options}
        disabled={busy}
        getKey={(a) => a.id}
        renderOption={(a) => {
          const typeLbl =
            a.licenseType === 'term'
              ? t('assets.licenseTerm')
              : a.licenseType === 'perpetual'
                ? t('assets.licensePerpetual')
                : t('assets.kindSoftware');
          const range =
            a.licenseType !== 'perpetual' && a.endDate
              ? `${formatDmy(a.startDate)} → ${formatDmy(a.endDate)}`
              : '';
          return (
            <>
              <span className="sw-opt-name">
                {a.licenseName ?? a.code}
                {/* Status ghế: Trống = gắn được ngay; Đang dùng = đang trên máy khác. */}
                <span
                  className={`sw-opt-badge ${a.installedOnCode ? 'used' : 'free'}`}
                >
                  {a.installedOnCode
                    ? t('assets.status.in_use')
                    : t('software.seatFree', 'Trống')}
                </span>
              </span>
              <small className="sw-opt-meta">
                {[typeLbl, range, a.note || null, a.installedOnCode || null]
                  .filter(Boolean)
                  .map((part, i) => (
                    <span key={i}>{part}</span>
                  ))}
              </small>
            </>
          );
        }}
        onSelect={(a) => {
          if (isCreate) {
            setPendingSw((prev) => [...prev, a]);
            setSwQuery('');
          } else {
            void moveSoftware(a.id, machineId);
          }
        }}
      />
    </div>
  );
}

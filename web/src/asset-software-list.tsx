import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from './api-client';
import { STATUS_BADGE, formatDmy } from './asset-types';

/** Phần mềm/license đang cài trên một máy (GET /assets/:id/software). */
export interface InstalledSoftware {
  id: string;
  code: string | null;
  licenseType: string | null;
  licenseName: string | null;
  startDate?: string | null;
  endDate: string | null;
  note?: string | null;
  status?: string | null;
}

/**
 * Bảng phần mềm đã cài trên máy — dùng chung ở hàng bung (▸) danh sách tài sản và
 * trang chi tiết. Cột phản chiếu trang "Phần mềm" (bỏ Máy/Người vì cố định = máy này).
 */
export function AssetSoftwareTable({ items }: { items: InstalledSoftware[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (items.length === 0) {
    return <p className="muted">{t('assets.noInstalledSoftware')}</p>;
  }
  // Bấm 1 dòng phần mềm → mở đúng bản đó ở trang license (giống bảng bên /phan-mem).
  const openSoftware = (s: InstalledSoftware) =>
    s.licenseName
      ? navigate(
          `/phan-mem/license/${encodeURIComponent(s.licenseName)}?seat=${s.id}`,
        )
      : navigate(`/tai-san/${s.id}`);
  // Card kiểu /phan-mem (.seat-list): License / Loại / Start / End / Trạng thái. Click → license.
  return (
    <>
      <div className="sw-detail-head">
        {t('assets.installedTitle', { n: items.length, defaultValue: 'Phần mềm đang cài ({{n}})' })}
      </div>
      <div className="seat-list inst-list">
        <div className="seat-hd">
          <span>{t('assets.licenseName')}</span>
          <span>{t('assets.licenseType')}</span>
          <span>{t('assets.startDate')}</span>
          <span>{t('assets.endDate')}</span>
          <span>{t('assets.note')}</span>
          <span>{t('assets.statusLabel')}</span>
        </div>
        {items.map((s) => (
          <div
            key={s.id}
            className="seat-card clickable"
            onClick={() => openSoftware(s)}
          >
            <div className="seat-mc">
              {s.licenseName ?? <span className="mono">{s.code}</span>}
            </div>
            <div>
              {s.licenseType === 'term' ? (
                <span className="badge warn">{t('assets.licenseTerm')}</span>
              ) : s.licenseType === 'perpetual' ? (
                <span className="badge ok">{t('assets.licensePerpetual')}</span>
              ) : (
                <span className="muted">—</span>
              )}
            </div>
            <div className="seat-date">{formatDmy(s.startDate)}</div>
            <div className="seat-date">
              {s.licenseType === 'perpetual'
                ? t('assets.licensePerpetual')
                : formatDmy(s.endDate)}
            </div>
            <div className="seat-note" title={s.note ?? undefined}>
              {s.note || '—'}
            </div>
            <div>
              {s.status ? (
                <span className={`badge ${STATUS_BADGE[s.status] ?? 'muted'}`}>
                  {t(`assets.status.${s.status}`)}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Bọc fetch cho hàng bung ▸: tải phần mềm của máy khi mở rồi render bảng. */
export function AssetSoftwareExpand({ assetId }: { assetId: string }) {
  const [items, setItems] = useState<InstalledSoftware[] | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<InstalledSoftware[]>(
      `/api/admin/assets/${encodeURIComponent(assetId)}/software`,
    )
      .then((d) => alive && setItems(d))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [assetId]);

  if (items === null) {
    return (
      <div className="exp-soft">
        <span className="muted-empty">…</span>
      </div>
    );
  }
  return (
    <div className="exp-soft">
      <AssetSoftwareTable items={items} />
    </div>
  );
}

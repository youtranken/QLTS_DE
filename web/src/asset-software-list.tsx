import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from './api-client';
import { STATUS_BADGE } from './asset-types';

/** Phần mềm/license đang cài trên một máy (GET /assets/:id/software). */
export interface InstalledSoftware {
  id: string;
  code: string | null;
  licenseType: string | null;
  licenseName: string | null;
  startDate?: string | null;
  endDate: string | null;
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
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('assets.licenseName')}</th>
            <th>{t('assets.licenseType')}</th>
            <th>{t('assets.startDate')}</th>
            <th>{t('assets.endDate')}</th>
            <th>{t('assets.statusLabel')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr
              key={s.id}
              className="clickable"
              onClick={() => openSoftware(s)}
            >
              <td>{s.licenseName ?? <span className="mono">{s.code}</span>}</td>
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
              <td>
                {s.status ? (
                  <span className={`badge ${STATUS_BADGE[s.status] ?? 'muted'}`}>
                    {t(`assets.status.${s.status}`)}
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

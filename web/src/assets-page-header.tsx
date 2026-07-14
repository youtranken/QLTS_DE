import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/**
 * Đầu trang sổ tài sản: tiêu đề (tài sản / phần mềm / kho thanh lý / tên license), link kiểm kê
 * + nhập, nút export theo bộ lọc ĐANG áp, và nút Thêm. Thuần trình bày. Export dùng thẻ <a>
 * điều hướng thật để cookie đi kèm (2.10).
 */
export interface AssetsPageHeaderProps {
  licenseName?: string;
  softwareOnly: boolean;
  disposedOnly: boolean;
  search: string;
  type: string;
  status: string;
  expiring: boolean;
  endFrom: string;
  endTo: string;
  onAdd: () => void;
}

export function AssetsPageHeader({
  licenseName,
  softwareOnly,
  disposedOnly,
  search,
  type,
  status,
  expiring,
  endFrom,
  endTo,
  onAdd,
}: AssetsPageHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="page-header">
      <h1>
        {licenseName
          ? licenseName
          : disposedOnly
            ? softwareOnly
              ? t('nav.disposedSoftware')
              : t('nav.disposedDevices')
            : softwareOnly
              ? t('software.title')
              : t('nav.assets')}
      </h1>
      {!softwareOnly && !disposedOnly && (
        <>
          <Link className="linkbtn" to="/tai-san/kiem-ke">
            {t('inventory.link')}
          </Link>
          <Link className="linkbtn" to="/tai-san/import">
            {t('importx.link')}
          </Link>
          {/* 2.10: export theo bộ lọc ĐANG áp — <a> điều hướng thật, cookie đi kèm */}
          <a
            className="linkbtn"
            href={`/api/admin/assets/export?${new URLSearchParams({
              ...(search ? { search } : {}),
              ...(type ? { type } : {}),
              ...(status ? { status } : {}),
              ...(expiring ? { expiring: 'true' } : {}),
              ...(endFrom ? { endFrom } : {}),
              ...(endTo ? { endTo } : {}),
            }).toString()}`}
          >
            {t('assets.exportExcel')}
          </a>
        </>
      )}
      {/* sw-license-model follow-up: export PHẦN MỀM riêng (derive người đứng tên theo máy) */}
      {softwareOnly && (
        <a
          className="linkbtn"
          href={`/api/admin/assets/export-software?${new URLSearchParams({
            ...(search ? { search } : {}),
            ...(status ? { status } : {}),
            ...(expiring ? { expiring: 'true' } : {}),
            ...(endFrom ? { endFrom } : {}),
            ...(endTo ? { endTo } : {}),
          }).toString()}`}
        >
          {t('assets.exportExcel')}
        </a>
      )}
      {!disposedOnly && (
        <button type="button" className="primary" onClick={onAdd}>
          {softwareOnly
            ? licenseName
              ? t('software.addSeat')
              : t('software.add')
            : t('assets.addAsset')}
        </button>
      )}
    </div>
  );
}

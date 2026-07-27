import { useTranslation } from 'react-i18next';
import { downloadFile } from '@/download-file';

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
  onImport: () => void;
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
  onImport,
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
          <button type="button" className="linkbtn" onClick={onImport}>
            {t('importx.link')}
          </button>
          {/* 2.10: export theo bộ lọc ĐANG áp — tải bằng fetch→blob (downloadFile) để ép
              đúng tên .xlsx trên mọi trình duyệt; cookie đi kèm qua credentials. */}
          <button
            type="button"
            className="linkbtn"
            onClick={() =>
              void downloadFile(
                `/api/admin/assets/export?${new URLSearchParams({
                  ...(search ? { search } : {}),
                  ...(type ? { type } : {}),
                  ...(status ? { status } : {}),
                  ...(expiring ? { expiring: 'true' } : {}),
                  ...(endFrom ? { endFrom } : {}),
                  ...(endTo ? { endTo } : {}),
                }).toString()}`,
                'tai-san.xlsx',
              )
            }
          >
            {t('assets.exportExcel')}
          </button>
        </>
      )}
      {/* sw-license-model follow-up: export PHẦN MỀM riêng (derive người đứng tên theo máy) */}
      {softwareOnly && (
        <button
          type="button"
          className="linkbtn"
          onClick={() =>
            void downloadFile(
              `/api/admin/assets/export-software?${new URLSearchParams({
                ...(search ? { search } : {}),
                ...(status ? { status } : {}),
                ...(expiring ? { expiring: 'true' } : {}),
                ...(endFrom ? { endFrom } : {}),
                ...(endTo ? { endTo } : {}),
              }).toString()}`,
              'phan-mem.xlsx',
            )
          }
        >
          {t('assets.exportExcel')}
        </button>
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

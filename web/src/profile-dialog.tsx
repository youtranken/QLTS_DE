import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ProfilePage } from './profile';
import type { Me } from './panels';

/**
 * Hồ sơ dạng POPUP (thay vì chuyển trang) — mở từ nút "Hồ sơ" ở sidebar. Bọc ProfilePage trong
 * .sheet để giữ nguyên nội dung (tài sản/lịch sử) mà không rời trang đang xem.
 * Portal ra body: dialog render TRONG sidebar (.sidebar position:sticky → LUÔN tạo stacking
 * context) nên .modal-backdrop z-index:50 bị giam trong context sidebar, vẽ trước .page → lịch
 * đè lên trên. Portal thoát ra body để backdrop phủ toàn viewport như các modal ở .page.
 */
export function ProfileDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="sheet sheet-wide"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <span className="sheet-title">{t('profile.myProfile', 'Hồ sơ')}</span>
          <span className="spacer" />
          <button
            type="button"
            className="sheet-close"
            aria-label={t('assets.cancel')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="sheet-body">
          <ProfilePage me={me} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

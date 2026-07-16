import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ProfilePage } from './profile';
import type { Me } from './panels';

/**
 * Hồ sơ dạng POPUP (thay vì chuyển trang) — mở từ nút "Hồ sơ" ở sidebar. Bọc ProfilePage trong
 * .sheet để giữ nguyên nội dung (tài sản/lịch sử) mà không rời trang đang xem.
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

  return (
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
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { ProfilePage } from '@/profile';
import { Dialog, DialogTitle, DialogClose } from '@/ui/dialog';
import type { Me } from '@/lib/me';

/**
 * Hồ sơ dạng POPUP (thay vì chuyển trang) — mở từ nút "Hồ sơ" ở sidebar. Bọc ProfilePage trong
 * .sheet để giữ nguyên nội dung (tài sản/lịch sử) mà không rời trang đang xem.
 * Dialog (Radix) tự portal ra body nên backdrop phủ toàn viewport (không bị giam trong
 * stacking context của .sidebar) + lo focus trap/scroll-lock/Esc.
 */
export function ProfileDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} className="sheet sheet-wide">
      <div className="sheet-header">
        <DialogTitle className="sheet-title">
          {t('profile.myProfile', 'Hồ sơ')}
        </DialogTitle>
        <span className="spacer" />
        <DialogClose asChild>
          <button type="button" className="sheet-close" aria-label={t('assets.cancel')}>
            ✕
          </button>
        </DialogClose>
      </div>
      <div className="sheet-body">
        <ProfilePage me={me} />
      </div>
    </Dialog>
  );
}

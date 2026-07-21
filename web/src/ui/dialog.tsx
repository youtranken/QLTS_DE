import * as RD from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

/**
 * Khung modal dùng chung trên Radix Dialog — thay các khối .modal-backdrop/.sheet
 * copy tay (mỗi dialog một bản). Radix lo focus trap, scroll-lock, Esc, trả focus,
 * aria-modal + aria-labelledby (qua DialogTitle) — thứ 8 modal cũ đều thiếu.
 *
 * Giữ NGUYÊN class .sheet cũ để giao diện y hệt: Overlay = nền mờ (.modal-backdrop),
 * .dialog-viewport canh giữa bằng grid (như .modal-backdrop cũ từng bọc .sheet) nên
 * .sheet vẫn dùng animation modalIn (transform) mà không đụng nhau.
 */
export const DialogTitle = RD.Title;
export const DialogDescription = RD.Description;
export const DialogClose = RD.Close;

export function Dialog({
  open,
  onOpenChange,
  dismissible = true,
  wide = false,
  maxWidth,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // false = chặn đóng bằng Esc/click-ngoài (vd đang busy) — nút đóng tự disable.
  dismissible?: boolean;
  wide?: boolean;
  maxWidth?: number;
  children: ReactNode;
}) {
  const block = dismissible ? undefined : (e: Event) => e.preventDefault();
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="modal-backdrop" />
        <div className="dialog-viewport">
          <RD.Content
            className={wide ? 'sheet sheet-wide' : 'sheet'}
            style={maxWidth ? { maxWidth } : undefined}
            onEscapeKeyDown={block}
            onPointerDownOutside={block}
            onInteractOutside={block}
          >
            {children}
          </RD.Content>
        </div>
      </RD.Portal>
    </RD.Root>
  );
}

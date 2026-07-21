import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react';
import type { Placement } from '@floating-ui/react';

/**
 * Định vị menu neo theo trigger — thay 5 bản copy tay (getBoundingClientRect + tự tính
 * flip + nghe scroll/resize). Floating UI lo flip/shift/collision + đo kích thước THẬT +
 * autoUpdate (cuộn/resize/đổi layout). Portal ra body ở nơi gọi; z-index từ CSS class.
 */
export function useAnchoredMenu(
  open: boolean,
  opts?: { matchWidth?: boolean; maxHeight?: number; placement?: Placement },
) {
  const { matchWidth = false, maxHeight = 320, placement = 'bottom-start' } =
    opts ?? {};

  const { refs, floatingStyles } = useFloating({
    open,
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ rects, elements, availableHeight }) {
          elements.floating.style.maxHeight = `${Math.min(availableHeight, maxHeight)}px`;
          if (matchWidth) {
            elements.floating.style.width = `${rects.reference.width}px`;
          }
        },
      }),
    ],
  });

  return { refs, floatingStyles };
}

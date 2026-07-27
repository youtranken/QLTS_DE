import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/confirm-dialog';

/**
 * Thay window.confirm bằng ConfirmDialog (Radix) qua một API async dùng chung:
 *   const askConfirm = useConfirm();
 *   if (!(await askConfirm({ message, danger: true }))) return;
 * Một dialog duy nhất ở gốc app — nơi gọi chỉ đổi 1 dòng, không tự quản state/JSX.
 */
export type ConfirmOptions = {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn>(() => Promise.resolve(false));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const askConfirm = useCallback<ConfirmFn>((o) => {
    // Nếu còn hộp cũ chưa trả lời (gọi confirm chồng nhau) → settle(false) trước,
    // nếu không resolver cũ bị ghi đè và Promise cũ treo vĩnh viễn (caller kẹt await).
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  };

  return (
    <ConfirmCtx.Provider value={askConfirm}>
      {children}
      {opts && (
        <ConfirmDialog
          title={opts.title ?? t('app.confirmTitle')}
          message={opts.message}
          confirmLabel={opts.confirmLabel ?? t('app.confirmOk')}
          cancelLabel={opts.cancelLabel}
          danger={opts.danger}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}

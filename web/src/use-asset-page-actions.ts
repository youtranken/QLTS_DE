import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { QueryClient } from '@tanstack/react-query';
import { detailToForm } from '@/asset-types';
import type { AssetDetail, AssetRow, FormState } from '@/asset-types';
import { useConfirm } from '@/ui/confirm-provider';
import type { Me } from '@/me';

/**
 * Các thao tác hàng của sổ tài sản (mở sửa / copy / xóa cứng / xóa vĩnh viễn). Tách khỏi
 * AssetsPage (§6) — thuần logic gọi API + optimistic-lock version, không dính JSX/cột.
 */
export function useAssetPageActions(ctx: {
  me: Me;
  setForm: (f: FormState | null) => void;
  setError: (e: string | null) => void;
  queryClient: QueryClient;
  loadMeta: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const { me, setForm, setError, queryClient, loadMeta } = ctx;

  const openEdit = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
        if (!res.ok) {
          setError(t('assets.loadFailed'));
          return;
        }
        const a = (await res.json()) as AssetDetail;
        setForm(detailToForm(a));
      } catch {
        setError(t('app.serverUnreachable'));
      }
    },
    [t, setForm, setError],
  );

  // 9.1: Copy phần mềm — nhân bản 1 bản ghi gần giống sang form TẠO MỚI (mã trống, chưa gắn máy).
  const copyFrom = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
        if (!res.ok) {
          setError(t('assets.loadFailed'));
          return;
        }
        const a = (await res.json()) as AssetDetail;
        setForm({
          ...detailToForm(a),
          id: null,
          version: 1,
          status: 'in_use',
          code: '',
          installedOnAssetId: '',
          installedOnCode: '',
        });
      } catch {
        setError(t('app.serverUnreachable'));
      }
    },
    [t, setForm, setError],
  );

  // 11.1: Xóa cứng tài sản "sạch". BE chặn (409) nếu đã ở pool/có booking/software/lịch sử
  // → hiện đúng message hướng dùng Thanh lý. Gửi version (optimistic lock) + CSRF.
  const handleDelete = useCallback(
    async (row: AssetRow) => {
      setError(null);
      const label = row.code ?? row.licenseName ?? '';
      if (
        !(await askConfirm({
          title: t('assets.deleteConfirmTitle'),
          message: t('assets.deleteConfirm', { code: label }),
          confirmLabel: t('assets.delete'),
          danger: true,
        }))
      )
        return;
      try {
        // List không trả version → lấy version tươi từ detail (optimistic lock).
        const detailRes = await fetch(
          `/api/admin/assets/${encodeURIComponent(row.id)}`,
        );
        if (!detailRes.ok) {
          setError(t('assets.deleteFailed'));
          return;
        }
        const { version } = (await detailRes.json()) as AssetDetail;
        const res = await fetch(`/api/admin/assets/${encodeURIComponent(row.id)}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({ version }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          setError(body?.message ?? t('assets.deleteFailed'));
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ['assets'] });
        void loadMeta();
      } catch {
        setError(t('app.serverUnreachable'));
      }
    },
    [t, askConfirm, me.csrfToken, queryClient, loadMeta, setError],
  );

  // Xóa VĨNH VIỄN 1 máy đã thanh lý (Kho thanh lý) — cascade lịch sử/booking; audit_log vẫn giữ.
  // KHÔNG tự confirm/invalidate: xác nhận do ConfirmDialog lo, invalidate do người gọi lo (để
  // gộp 1 lần cho cả bulk). Trả {ok, error} cho từng máy — bulk cộng dồn kết quả.
  const purgeById = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const detailRes = await fetch(
          `/api/admin/assets/${encodeURIComponent(id)}`,
        );
        if (!detailRes.ok) return { ok: false, error: t('assets.deleteFailed') };
        const { version } = (await detailRes.json()) as AssetDetail;
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(id)}/purge`,
          {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({ version }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          return { ok: false, error: body?.message ?? t('assets.deleteFailed') };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: t('app.serverUnreachable') };
      }
    },
    [t, me.csrfToken],
  );

  // Thanh lý 1 bản phần mềm (→ Kho thanh lý): POST :id/dispose (status=disposed). Không tự
  // confirm/invalidate (ConfirmDialog + người gọi lo) — trả {ok,error} để bulk cộng dồn.
  const disposeById = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const detailRes = await fetch(
          `/api/admin/assets/${encodeURIComponent(id)}`,
        );
        if (!detailRes.ok) return { ok: false, error: t('assets.saveFailed') };
        const { version } = (await detailRes.json()) as AssetDetail;
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(id)}/dispose`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({ version }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          return { ok: false, error: body?.message ?? t('assets.saveFailed') };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: t('app.serverUnreachable') };
      }
    },
    [t, me.csrfToken],
  );

  return { openEdit, copyFrom, handleDelete, purgeById, disposeById };
}

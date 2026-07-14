import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { QueryClient } from '@tanstack/react-query';
import { detailToForm } from './asset-types';
import type { AssetDetail, AssetRow, FormState } from './asset-types';
import type { Me } from './panels';

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
      if (!window.confirm(t('assets.deleteConfirm', { code: label }))) return;
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
    [t, me.csrfToken, queryClient, loadMeta, setError],
  );

  // Xóa VĨNH VIỄN máy đã thanh lý (Kho thanh lý) — cascade lịch sử/booking; audit_log vẫn giữ.
  const handlePurge = useCallback(
    async (row: AssetRow) => {
      setError(null);
      const label = row.code ?? row.licenseName ?? '';
      if (
        !window.confirm(
          t('assets.purgeConfirm', {
            code: label,
            defaultValue:
              'Xóa VĨNH VIỄN "{{code}}"? Không thể hoàn tác. Lịch sử cấp phát/booking của máy sẽ bị xóa (vết audit vẫn được giữ).',
          }),
        )
      ) {
        return;
      }
      try {
        const detailRes = await fetch(
          `/api/admin/assets/${encodeURIComponent(row.id)}`,
        );
        if (!detailRes.ok) {
          setError(t('assets.deleteFailed'));
          return;
        }
        const { version } = (await detailRes.json()) as AssetDetail;
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(row.id)}/purge`,
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
          setError(body?.message ?? t('assets.deleteFailed'));
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ['assets'] });
        void loadMeta();
      } catch {
        setError(t('app.serverUnreachable'));
      }
    },
    [t, me.csrfToken, queryClient, loadMeta, setError],
  );

  return { openEdit, copyFrom, handleDelete, handlePurge };
}

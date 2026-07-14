import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from './panels';
import { detailToForm } from './asset-types';
import type {
  AssetDetail,
  AssetRow,
  CascadePreview,
  FormState,
  PendingCascade,
  UserOption,
} from './asset-types';
import type { Seat } from './software-seats-fields';
import { useDebouncedSearch } from './use-asset-search';
import { useAssetCatalog } from './use-asset-catalog';
import { useAssetSave } from './use-asset-save';

/** Phần mềm đã cài trên máy đang sửa (2.4) — hiển thị trong AssetSoftwarePicker. */
export interface InstalledSoftware {
  id: string;
  code: string | null;
  licenseType: string | null;
  licenseName: string | null;
  startDate: string | null;
  endDate: string | null;
  brand: string | null;
}

/**
 * Bộ não của form thêm/sửa tài sản — giữ state + effect + handler nghiệp vụ vòng đời/transfer,
 * điều phối các hook con: use-asset-search (3 combobox), use-asset-catalog (dropdown danh mục),
 * use-asset-save (luồng lưu). asset-form.tsx chỉ còn phần trình bày. Bê nguyên, KHÔNG đổi hành vi.
 *
 * §6: file ~406 dòng (nhỉnh ngưỡng 400). Phần còn lại (doLifecycle, previewThenRun, transfer,
 * moveSoftware, reload) là state-machine HUB — bám chặt cùng bộ state (setForm, setTransferred,
 * các setter host/sw). Tách tiếp buộc truyền hơn 10 setter qua context → smell nặng hơn 6 dòng
 * vượt, nên GIỮ ở đây. Chỉ tách các cụm tự-chứa (search, catalog, save) như trên.
 */
export function useAssetForm({
  me,
  initial,
  onDone,
}: {
  me: Me;
  initial: FormState;
  onDone: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  // Thêm NHIỀU bản (seat) cùng license — mỗi bản kỳ hạn + ghi chú riêng (mua 20-30 bản chung tên).
  const [seats, setSeats] = useState<Seat[]>([
    { startDate: '', endDate: '', cost: '', note: '' },
  ]);
  // 2.5/2.6: đã đổi qua endpoint phụ (transfer/vòng đời) → Hủy vẫn refresh danh sách
  const [transferred, setTransferred] = useState(false);
  // 3.13: popup xác nhận cascade + cờ báo mail (preview trước khi Thanh lý qua dropdown Trạng thái)
  const [cascade, setCascade] = useState<PendingCascade | null>(null);
  const [notifyUsers, setNotifyUsers] = useState(true);
  const [installedSoftware, setInstalledSoftware] = useState<InstalledSoftware[]>(
    [],
  );
  // 9.4: đếm để reload danh sách phần mềm đã cài sau khi gắn/gỡ.
  const [swReload, setSwReload] = useState(0);
  // #2: phần mềm chọn sẵn khi TẠO máy — attach sau khi tạo (cần id máy mới).
  const [pendingSw, setPendingSw] = useState<AssetRow[]>([]);

  // 8.2: danh mục Loại/Hãng/Cấu hình/Vị trí + nút (+) thêm nhanh Cấu hình.
  const {
    catType,
    catBrand,
    catConfig,
    catPlace,
    addConfig,
    addingConfig,
  } = useAssetCatalog(me.csrfToken, form.configuration);

  // Người đứng tên (users có thể ~3.000 — không tải hết, tìm server-side).
  const {
    query: userQuery,
    setQuery: setUserQuery,
    options: userOptions,
    setOptions: setUserOptions,
  } = useDebouncedSearch<UserOption>(
    (q) => `/api/admin/users?search=${encodeURIComponent(q)}&page=1&pageSize=20`,
    (body) => (body as { items?: UserOption[] }).items ?? [],
  );

  // 2.4: máy chủ để cài phần mềm — loại software, loại máy thanh lý, loại chính máy đang gắn.
  const {
    query: hostQuery,
    setQuery: setHostQuery,
    options: hostOptions,
    setOptions: setHostOptions,
  } = useDebouncedSearch<AssetRow>(
    (q) => `/api/admin/assets?search=${encodeURIComponent(q)}&page=1&pageSize=20`,
    (body) =>
      ((body as { items?: AssetRow[] }).items ?? []).filter(
        (a) =>
          a.type !== 'software' &&
          a.status !== 'disposed' &&
          a.id !== form.installedOnAssetId,
      ),
    [form.installedOnAssetId],
  );

  // 9.4: tìm phần mềm (software chưa thanh lý) để gắn vào máy đang sửa.
  const {
    query: swQuery,
    setQuery: setSwQuery,
    options: swOptions,
    setOptions: setSwOptions,
  } = useDebouncedSearch<AssetRow>(
    (q) =>
      `/api/admin/assets?search=${encodeURIComponent(q)}&type=software&page=1&pageSize=20`,
    (body) =>
      ((body as { items?: AssetRow[] }).items ?? []).filter(
        (a) => a.status !== 'disposed',
      ),
  );

  // Phần mềm đã cài trên máy đang sửa — nạp lại sau mỗi lần gắn/gỡ (swReload).
  useEffect(() => {
    if (!form.id || form.isSoftware) return;
    const controller = new AbortController();
    fetch(`/api/admin/assets/${encodeURIComponent(form.id)}/software`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.ok) {
          setInstalledSoftware((await res.json()) as InstalledSoftware[]);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [form.id, form.isSoftware, swReload]);

  // STALE_VERSION: nạp lại bản mới nhất (version mới) ngay tại form — không mất chỗ đứng
  const reload = useCallback(async () => {
    if (!form.id) return;
    try {
      const res = await fetch(`/api/admin/assets/${encodeURIComponent(form.id)}`);
      if (!res.ok) return;
      setForm(detailToForm((await res.json()) as AssetDetail));
      setError(null);
      setStale(false);
    } catch {
      setError(t('app.serverUnreachable'));
    }
  }, [form.id, t]);

  const set = (key: keyof FormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Cụm LƯU (tạo/sửa + gắn phần mềm sau tạo) tách ra use-asset-save (§6).
  const submit = useAssetSave({
    form,
    seats,
    pendingSw,
    csrfToken: me.csrfToken,
    onDone,
    setError,
    setBusy,
    setStale,
  });

  // 2.6: 4 thao tác vòng đời — chỉ cập nhật version + trường đổi (bài học 2.5)
  const doLifecycle = useCallback(
    async (
      path: string,
      method: 'POST' | 'PUT',
      extra: Record<string, unknown>,
      patch: Partial<FormState>,
    ) => {
      if (!form.id) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(form.id)}/${path}`,
          {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({ ...extra, version: form.version }),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { version: number };
          setTransferred(true);
          setForm((f) => ({ ...f, ...patch, version: body.version }));
          if (path === 'dispose') setInstalledSoftware([]); // license đã tự gỡ
          return;
        }
        const body = (await res.json()) as { code?: string; message?: string };
        if (body.code === 'STALE_VERSION') {
          setError(t('assets.staleVersion'));
          setStale(true);
        } else {
          setError(body.message ?? t('assets.saveFailed'));
        }
      } catch {
        setError(t('app.serverUnreachable'));
      } finally {
        setBusy(false);
      }
    },
    [form.id, form.version, me.csrfToken, t],
  );

  /**
   * 3.13: Khóa/Gỡ pool/Thanh lý → lấy PREVIEW trước. Có booking/ticket bị ảnh hưởng thì mở
   * popup cho Admin xem + xác nhận (kèm tick báo mail); không có gì thì chạy thẳng.
   * Preview lỗi → không chặn thao tác, chạy thẳng (notify mặc định true ở server).
   */
  const previewThenRun = useCallback(
    async (
      path: string,
      method: 'POST' | 'PUT',
      extra: Record<string, unknown>,
      patch: Partial<FormState>,
    ) => {
      if (!form.id) return;
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(form.id)}/lifecycle-preview`,
        );
        if (res.ok) {
          const data = (await res.json()) as CascadePreview;
          if (
            data.futureCancellations.length > 0 ||
            data.inUseRecalls.length > 0
          ) {
            setNotifyUsers(true);
            setCascade({ path, method, extra, patch, data });
            return;
          }
        }
      } catch {
        // preview hỏng → không chặn; chạy thẳng
      }
      void doLifecycle(path, method, extra, patch);
    },
    [form.id, doLifecycle],
  );

  // 2.5: chuyển license sang máy khác / gỡ về "chưa gắn máy" — endpoint riêng
  const transfer = useCallback(
    async (target: { id: string; code: string } | null) => {
      if (!form.id) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(form.id)}/transfer`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({
              ...(target ? { targetAssetId: target.id } : {}),
              version: form.version,
            }),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { version: number };
          setHostQuery('');
          setHostOptions([]);
          setTransferred(true);
          // chỉ cập nhật version + máy — KHÔNG reload cả form (mất dữ liệu đang gõ, review 2.5)
          setForm((f) => ({
            ...f,
            version: body.version,
            installedOnAssetId: target?.id ?? '',
            installedOnCode: target?.code ?? '',
          }));
          return;
        }
        const body = (await res.json()) as { code?: string; message?: string };
        if (body.code === 'STALE_VERSION') {
          setError(t('assets.staleVersion'));
          setStale(true);
        } else {
          setError(body.message ?? t('assets.transferFailed'));
        }
      } catch {
        setError(t('app.serverUnreachable'));
      } finally {
        setBusy(false);
      }
    },
    [form.id, form.version, me.csrfToken, setHostQuery, setHostOptions, t],
  );

  // 9.4: gắn/gỡ phần mềm vào MÁY đang sửa — tái dùng endpoint transfer của chính software
  // (đọc version của software rồi PUT). targetAssetId có = gắn vào máy này; bỏ trống = gỡ.
  const moveSoftware = useCallback(
    async (softwareId: string, targetAssetId: string | null) => {
      if (!form.id) return;
      setBusy(true);
      setError(null);
      try {
        const detailRes = await fetch(
          `/api/admin/assets/${encodeURIComponent(softwareId)}`,
        );
        if (!detailRes.ok) {
          setError(t('assets.saveFailed'));
          return;
        }
        const sw = (await detailRes.json()) as AssetDetail;
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(softwareId)}/transfer`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
            },
            body: JSON.stringify({
              ...(targetAssetId ? { targetAssetId } : {}),
              version: sw.version,
            }),
          },
        );
        if (res.ok) {
          setSwQuery('');
          setSwOptions([]);
          setSwReload((n) => n + 1);
          return;
        }
        const body = (await res.json()) as { message?: string };
        setError(body.message ?? t('assets.transferFailed'));
      } catch {
        setError(t('app.serverUnreachable'));
      } finally {
        setBusy(false);
      }
    },
    [form.id, me.csrfToken, setSwQuery, setSwOptions, t],
  );

  const close = () => onDone(transferred);

  // Giữ giá trị hiện hành của tài sản cũ trong dropdown dù đã bị ẩn khỏi danh mục (edit legacy).
  const withCurrent = (list: string[], cur: string) =>
    cur && !list.includes(cur) ? [cur, ...list] : list;
  const typeOptions = withCurrent(
    catType.filter((v) => v.toLowerCase() !== 'software'),
    form.type,
  );
  const brandOptions = withCurrent(catBrand, form.brand);
  const placeOptions = withCurrent(catPlace, form.floor);

  // TẠO phần mềm: nhập kỳ hạn theo TỪNG bản (per-seat), không gắn máy ở đây (gán sau).
  const softwareCreate = !form.id && form.isSoftware;
  // Chọn/chuyển máy (Cài trên máy) chỉ khi SỬA 1 bản phần mềm — tạo mới thì gán sau.
  const showInstall = form.isSoftware && !!form.id && form.status !== 'disposed';

  return {
    t,
    form,
    setForm,
    set,
    error,
    stale,
    busy,
    seats,
    setSeats,
    cascade,
    setCascade,
    notifyUsers,
    setNotifyUsers,
    installedSoftware,
    pendingSw,
    setPendingSw,
    userQuery,
    setUserQuery,
    userOptions,
    setUserOptions,
    hostQuery,
    setHostQuery,
    hostOptions,
    setHostOptions,
    swQuery,
    setSwQuery,
    swOptions,
    catConfig,
    addConfig,
    addingConfig,
    typeOptions,
    brandOptions,
    placeOptions,
    softwareCreate,
    showInstall,
    reload,
    submit,
    doLifecycle,
    previewThenRun,
    transfer,
    moveSoftware,
    close,
  };
}

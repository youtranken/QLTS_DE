import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import { AssetOwnerPanel } from './asset-owner-panel';
import { AssetSoftwarePicker } from './asset-software-picker';
import { AssetGeneralFields } from './asset-general-fields';
import { AssetLifecyclePanel } from './asset-lifecycle-panel';
import { AssetInstalledOn } from './asset-installed-on';
import { AssetCascadeDialog } from './asset-cascade-dialog';
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

/**
 * Form thêm/sửa tài sản (FR-30) — dạng popup (sheet modal) cho cả Thêm và Sửa.
 * status/pool KHÔNG sửa ở đây — nghiệp vụ vòng đời 2.6. Đóng: nút ✕ / Hủy / Esc.
 */
export function AssetForm({
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
  const [userQuery, setUserQuery] = useState('');
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  // 2.5/2.6: đã đổi qua endpoint phụ (transfer/vòng đời) → Hủy vẫn refresh danh sách
  const [transferred, setTransferred] = useState(false);
  // 2.6: form khóa máy (lý do bắt buộc + ETA tùy chọn)
  const [showLockForm, setShowLockForm] = useState(false);
  const [lockReason, setLockReason] = useState('');
  const [lockEta, setLockEta] = useState('');
  // 3.13: popup xác nhận cascade + cờ báo mail (preview trước khi Khóa/Gỡ pool/Thanh lý)
  const [cascade, setCascade] = useState<PendingCascade | null>(null);
  const [notifyUsers, setNotifyUsers] = useState(true);
  // 2.3/11.2: ghi chú cấp phát + lịch sử A→B đã chuyển vào AssetOwnerPanel (khi sửa máy).
  // 2.4: picker máy cài (chỉ khi TẠO software) + software đã cài (khi sửa máy)
  const [hostQuery, setHostQuery] = useState('');
  const [hostOptions, setHostOptions] = useState<AssetRow[]>([]);
  const [installedSoftware, setInstalledSoftware] = useState<
    Array<{
      id: string;
      code: string | null;
      licenseType: string | null;
      licenseName: string | null;
      endDate: string | null;
    }>
  >([]);
  // 9.4: gắn phần mềm vào máy đang sửa — tìm software để gắn + đếm để reload danh sách sau khi gắn/gỡ.
  const [swQuery, setSwQuery] = useState('');
  const [swOptions, setSwOptions] = useState<AssetRow[]>([]);
  const [swReload, setSwReload] = useState(0);
  // #2: phần mềm chọn sẵn khi TẠO máy — attach sau khi tạo (cần id máy mới).
  const [pendingSw, setPendingSw] = useState<AssetRow[]>([]);
  // 8.2: danh mục Loại/Hãng/Cấu hình (chỉ active) → dropdown chọn nhanh
  const [catType, setCatType] = useState<string[]>([]);
  const [catBrand, setCatBrand] = useState<string[]>([]);
  const [catConfig, setCatConfig] = useState<string[]>([]);
  const [addingConfig, setAddingConfig] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    const load = (kind: string, set: (v: string[]) => void) =>
      fetch(`/api/admin/catalog?kind=${kind}&activeOnly=true`, {
        signal: c.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<Array<{ value: string }>>) : []))
        .then((rows) => set(rows.map((x) => x.value)))
        .catch(() => undefined);
    void load('type', setCatType);
    void load('brand', setCatBrand);
    void load('configuration', setCatConfig);
    return () => c.abort();
  }, []);

  useEffect(() => {
    if (!hostQuery) {
      setHostOptions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/assets?search=${encodeURIComponent(hostQuery)}&page=1&pageSize=20`,
        { signal: controller.signal },
      )
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { items?: AssetRow[] };
          // chỉ máy: không phải software, không thanh lý (server chặn lại lần cuối);
          // loại máy ĐANG gắn — transfer vào chính nó là no-op nhiễu audit (review 2.5)
          setHostOptions(
            (body.items ?? []).filter(
              (a) =>
                a.type !== 'software' &&
                a.status !== 'disposed' &&
                a.id !== form.installedOnAssetId,
            ),
          );
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [hostQuery, form.installedOnAssetId]);

  useEffect(() => {
    if (!form.id || form.isSoftware) return;
    const controller = new AbortController();
    fetch(`/api/admin/assets/${encodeURIComponent(form.id)}/software`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.ok) {
          setInstalledSoftware((await res.json()) as typeof installedSoftware);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [form.id, form.isSoftware, swReload]);

  // 9.4: tìm phần mềm (software chưa thanh lý) để gắn vào máy đang sửa.
  useEffect(() => {
    if (!swQuery) {
      setSwOptions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/assets?search=${encodeURIComponent(swQuery)}&type=software&page=1&pageSize=20`,
        { signal: controller.signal },
      )
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { items?: AssetRow[] };
          setSwOptions(
            (body.items ?? []).filter((a) => a.status !== 'disposed'),
          );
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [swQuery]);

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

  // tìm người đứng tên server-side (users có thể ~3.000 — không tải hết)
  useEffect(() => {
    if (!userQuery) {
      setUserOptions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/users?search=${encodeURIComponent(userQuery)}&page=1&pageSize=20`,
        { signal: controller.signal },
      )
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { items?: UserOption[] };
          setUserOptions(body.items ?? []);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [userQuery]);

  const set = (key: keyof FormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  // 8.2: nút (+) thêm nhanh Cấu hình vào danh mục ngay tại form (Loại/Hãng thêm ở trang Danh mục).
  const addConfig = useCallback(async () => {
    const v = form.configuration.trim();
    if (!v || catConfig.includes(v)) return;
    setAddingConfig(true);
    try {
      const res = await fetch('/api/admin/catalog', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify({ kind: 'configuration', value: v }),
      });
      // 201 mới / 409 đã có (khác hoa-thường) → vẫn coi là có trong danh mục
      if (res.ok || res.status === 201 || res.status === 409) {
        setCatConfig((l) => (l.includes(v) ? l : [...l, v].sort()));
      }
    } catch {
      /* im lặng — thêm danh mục là phụ trợ, không chặn lưu tài sản */
    } finally {
      setAddingConfig(false);
    }
  }, [form.configuration, catConfig, me.csrfToken]);

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    const payload: Record<string, unknown> = {
      // Phần mềm: KHÔNG có mã/cấu hình/người đứng tên (BE cũng normalize) — gửi null để
      // qua DTO @IsOptional (chuỗi rỗng '' sẽ trượt @Length(1,100) → 400).
      code: form.isSoftware ? null : form.code,
      type: form.isSoftware ? 'software' : form.type,
      configuration: form.isSoftware ? null : form.configuration || null,
      cost: form.cost === '' ? null : Number(form.cost),
      startDate: form.startDate || null,
      // perpetual không có hạn — không gửi endDate còn sót lại trong state
      endDate:
        form.isSoftware && form.licenseType === 'perpetual'
          ? null
          : form.endDate || null,
      note: form.note || null,
      serial: form.serial || null,
      brand: form.brand || null,
      assignedUserSub: form.isSoftware ? null : form.assignedUserSub || null,
      licenseType: form.isSoftware ? form.licenseType || null : null,
      // term cũng được có tên license — không xóa ngầm khi sửa (review 2.4)
      licenseName: form.isSoftware ? form.licenseName || null : null,
    };
    if (form.id) {
      // 11.2 (B3): "Lưu thông tin máy" KHÔNG đổi người đứng tên — assignedUserSub gửi kèm
      // là giá trị HIỆN TẠI (giữ nguyên, tránh BE update ghi null). Đổi owner qua AssetOwnerPanel.
      payload.version = form.version;
    } else if (form.isSoftware && form.installedOnAssetId) {
      // gắn máy CHỈ khi tạo (AC 3) — đổi/gỡ là chức năng chuyển license (2.5)
      payload.installedOnAssetId = form.installedOnAssetId;
    }
    try {
      const res = await fetch(
        form.id
          ? `/api/admin/assets/${encodeURIComponent(form.id)}`
          : '/api/admin/assets',
        {
          method: form.id ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify(payload),
        },
      );
      if (res.ok) {
        // #2: tạo máy xong + có phần mềm chọn sẵn → gắn từng cái vào máy vừa tạo.
        if (!form.id && !form.isSoftware && pendingSw.length > 0) {
          const created = (await res
            .json()
            .catch(() => null)) as { id?: string } | null;
          let failed = 0;
          if (created?.id) {
            for (const sw of pendingSw) {
              const ok = await attachSoftwareToMachine(sw.id, created.id)
                .then(() => true)
                .catch(() => false);
              if (!ok) failed++;
            }
          } else {
            failed = pendingSw.length; // thiếu id máy trong response → không gắn được cái nào
          }
          if (failed > 0) {
            // Máy ĐÃ tạo nhưng gắn phần mềm lỗi — báo rõ (giữ modal) thay vì im lặng
            // báo thành công. Người dùng gắn lại qua "Sửa máy" khi thấy máy trong danh sách.
            setError(t('assets.attachAfterCreate', { n: failed }));
            setBusy(false);
            return;
          }
        }
        onDone(true);
        return;
      }
      const body = (await res.json()) as { code?: string; message?: string };
      if (body.code === 'STALE_VERSION') {
        setError(t('assets.staleVersion'));
        setStale(true);
      } else if (body.code === 'CODE_TAKEN') {
        setError(t('assets.codeTaken'));
      } else {
        setError(body.message ?? t('assets.saveFailed'));
      }
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
    // attachSoftwareToMachine cố ý không đưa vào deps (khai báo sau, ổn định theo csrfToken).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, pendingSw, me.csrfToken, onDone, t]);

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
          setShowLockForm(false);
          setLockReason('');
          setLockEta('');
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
    [form.id, form.version, me.csrfToken, t],
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
    [form.id, me.csrfToken, t],
  );

  // #2: gắn 1 phần mềm vào máy MỚI tạo (dùng lại endpoint transfer, không cần form.id).
  const attachSoftwareToMachine = useCallback(
    async (softwareId: string, machineId: string) => {
      const detailRes = await fetch(
        `/api/admin/assets/${encodeURIComponent(softwareId)}`,
      );
      if (!detailRes.ok) return;
      const sw = (await detailRes.json()) as AssetDetail;
      await fetch(
        `/api/admin/assets/${encodeURIComponent(softwareId)}/transfer`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({ targetAssetId: machineId, version: sw.version }),
        },
      );
    },
    [me.csrfToken],
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

  const showLifecycle = !!form.id;
  const showInstall = form.isSoftware && form.status !== 'disposed';

  return (
    <div
      className="modal-backdrop"
      onClick={close}
      onKeyDown={(e) => {
        // Esc đóng modal — trừ khi popup cascade đang mở (nó tự xử lý)
        if (e.key === 'Escape' && !cascade) close();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <span className="sheet-title">
            {form.id ? (
              <>
                {t('assets.edit')} ·{' '}
                {initial.isSoftware ? (
                  initial.licenseName || t('assets.kindSoftware')
                ) : (
                  <span className="mono">{initial.code}</span>
                )}
              </>
            ) : (
              t('assets.addAsset')
            )}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="sheet-close"
            aria-label={t('assets.cancel')}
            disabled={busy}
            onClick={close}
          >
            ✕
          </button>
        </div>

        <form
          style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="sheet-body">
            {error && (
              <p className="alert error">
                {error}{' '}
                {stale && (
                  <button type="button" className="sm" onClick={() => void reload()}>
                    {t('assets.reload')}
                  </button>
                )}
              </p>
            )}

            {!form.id && (
              // chọn bản chất bản ghi khi TẠO — sửa không đổi được (TYPE_SOFTWARE_IMMUTABLE)
              <div className="segmented" style={{ marginBottom: '1rem' }}>
                <label>
                  <input
                    type="radio"
                    name="kind"
                    checked={!form.isSoftware}
                    onChange={() =>
                      setForm((f) => ({
                        ...f,
                        isSoftware: false,
                        licenseType: '',
                        licenseName: '',
                        installedOnAssetId: '',
                        installedOnCode: '',
                      }))
                    }
                  />
                  {t('assets.kindDevice')}
                </label>
                <label>
                  <input
                    type="radio"
                    name="kind"
                    checked={form.isSoftware}
                    onChange={() => setForm((f) => ({ ...f, isSoftware: true }))}
                  />
                  {t('assets.kindSoftware')}
                </label>
              </div>
            )}

            <div className="form-section">
              <div className="form-section-title">{t('assets.sectionGeneral')}</div>
              <AssetGeneralFields
                form={form}
                set={set}
                typeOptions={typeOptions}
                brandOptions={brandOptions}
                catConfig={catConfig}
                addConfig={addConfig}
                addingConfig={addingConfig}
              />

              {/* 9.3: Người đứng tên đưa vào ngay Thông tin chung (trước là section riêng dưới cùng).
                  sw-license-model-redesign: CHỈ máy — phần mềm derive holder từ máy nó gắn, không nhập tay.
                  11.2 (B3): khi SỬA, người đứng tên tách ra AssetOwnerPanel (thao tác riêng);
                  ở đây CHỈ còn lúc TẠO máy (owner đi cùng payload create). */}
              {!form.isSoftware && !form.id && (
              <div className="form-subsection">
                <div className="form-section-title">{t('assets.assignee')}</div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    marginBottom: '0.6rem',
                    flexWrap: 'wrap',
                  }}
                >
                  {form.assignedUserSub ? (
                    <span className="chip">
                      {form.assignedUserName || form.assignedUserSub}
                      <button
                        type="button"
                        aria-label={t('assets.cancel')}
                        onClick={() => {
                          set('assignedUserSub')('');
                          set('assignedUserName')('');
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ) : (
                    <span className="muted">{t('assets.assigneeEmpty')}</span>
                  )}
                </div>
                <Combobox
                  placeholder={t('assets.assigneeSearch')}
                  query={userQuery}
                  onQuery={setUserQuery}
                  options={userOptions}
                  getKey={(u) => u.sub}
                  renderOption={(u) => (
                    <>
                      <span>{u.fullName ?? u.sub}</span>
                      {u.email && <small>{u.email}</small>}
                    </>
                  )}
                  onSelect={(u) => {
                    setForm((f) => ({
                      ...f,
                      assignedUserSub: u.sub,
                      assignedUserName: u.fullName ?? u.sub,
                    }));
                    setUserQuery('');
                    setUserOptions([]);
                  }}
                />
              </div>
              )}
            </div>

            {/* 11.2 (B3): Sửa máy — đổi người đứng tên là thao tác RIÊNG (PUT :id/assignee),
                không đi qua nút "Lưu thông tin máy". */}
            {form.id && !form.isSoftware && (
              <AssetOwnerPanel
                me={me}
                assetId={form.id}
                version={form.version}
                ownerSub={form.assignedUserSub}
                ownerName={form.assignedUserName}
                onSaved={(v, sub, name) =>
                  setForm((f) => ({
                    ...f,
                    version: v,
                    assignedUserSub: sub ?? '',
                    assignedUserName: name ?? '',
                  }))
                }
              />
            )}

            {showLifecycle && (
              <AssetLifecyclePanel
                form={form}
                busy={busy}
                showLockForm={showLockForm}
                setShowLockForm={setShowLockForm}
                lockReason={lockReason}
                setLockReason={setLockReason}
                lockEta={lockEta}
                setLockEta={setLockEta}
                doLifecycle={doLifecycle}
                previewThenRun={previewThenRun}
              />
            )}

            {/* software disposed: TERMINAL — không gắn/chuyển được nữa (review 2.6) */}
            {showInstall && (
              <AssetInstalledOn
                form={form}
                setForm={setForm}
                busy={busy}
                hostQuery={hostQuery}
                setHostQuery={setHostQuery}
                hostOptions={hostOptions}
                setHostOptions={setHostOptions}
                transfer={transfer}
              />
            )}

            {/* #2: chọn phần mềm cài sẵn NGAY khi tạo máy — gắn sau khi tạo. */}
            {!form.id && !form.isSoftware && (
              <AssetSoftwarePicker
                isCreate
                busy={busy}
                swQuery={swQuery}
                setSwQuery={setSwQuery}
                swOptions={swOptions}
                pendingSw={pendingSw}
                setPendingSw={setPendingSw}
                installedSoftware={[]}
                moveSoftware={moveSoftware}
                machineId={null}
              />
            )}

            {form.id && !form.isSoftware && form.status !== 'disposed' && (
              <AssetSoftwarePicker
                isCreate={false}
                busy={busy}
                swQuery={swQuery}
                setSwQuery={setSwQuery}
                swOptions={swOptions}
                pendingSw={[]}
                setPendingSw={setPendingSw}
                installedSoftware={installedSoftware}
                moveSoftware={moveSoftware}
                machineId={form.id}
              />
            )}

          </div>

          <div className="sheet-footer">
            <span className="spacer" />
            <button type="button" disabled={busy} onClick={close}>
              {t('assets.cancel')}
            </button>
            {/* disposed = hồ sơ đã chốt (F2) — server cũng chặn 409 DISPOSED_TERMINAL */}
            <button
              type="submit"
              className="primary"
              disabled={busy || (!!form.id && form.status === 'disposed')}
            >
              {busy && <span className="spinner" style={{ marginRight: 6 }} />}
              {t('assets.save')}
            </button>
          </div>
        </form>
      </div>

      {/* 3.13: popup xác nhận cascade — danh sách bị ảnh hưởng + cờ báo mail. Nằm TRÊN sheet. */}
      {cascade && (
        <AssetCascadeDialog
          cascade={cascade}
          setCascade={setCascade}
          notifyUsers={notifyUsers}
          setNotifyUsers={setNotifyUsers}
          busy={busy}
          doLifecycle={doLifecycle}
        />
      )}
    </div>
  );
}

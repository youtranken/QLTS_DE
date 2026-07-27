import { Combobox } from '@/ui/combobox';
import { AssetSoftwarePicker } from '@/features/assets/asset-software-picker';
import { AssetGeneralFields } from '@/features/assets/asset-general-fields';
import { SoftwareSeatsFields } from '@/software-seats-fields';
import { AssetInstalledOn } from '@/features/assets/asset-installed-on';
import { AssetCascadeDialog } from '@/features/assets/asset-cascade-dialog';
import { Dialog, DialogTitle, DialogClose } from '@/ui/dialog';
import { useConfirm } from '@/ui/confirm-provider';
import type { Me } from '@/lib/me';
import type { FormState } from '@/lib/asset-types';
import { useAssetForm } from '@/features/assets/use-asset-form';

/**
 * Form thêm/sửa tài sản (FR-30) — dạng popup (sheet modal) cho cả Thêm và Sửa.
 * status/pool KHÔNG sửa ở đây — nghiệp vụ vòng đời 2.6. Đóng: nút ✕ / Hủy / Esc.
 * Toàn bộ state + handler nằm trong useAssetForm; file này chỉ trình bày (§6).
 */
export function AssetForm({
  me,
  initial,
  onDone,
  lockSoftware = false,
  readOnly = false,
}: {
  me: Me;
  initial: FormState;
  onDone: (saved: boolean) => void;
  /** Form phần mềm THUẦN (từ /phan-mem, chi tiết license): ẩn toggle Thiết bị/Phần mềm. */
  lockSoftware?: boolean;
  /** Xem chi tiết (không sửa): khóa mọi input (fieldset disabled), ẩn nút Lưu. */
  readOnly?: boolean;
}) {
  const {
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
  } = useAssetForm({ me, initial, onDone });
  const askConfirm = useConfirm();

  return (
    <Dialog
      open
      // cascade (Radix nested) là lớp trên; chặn đóng form khi nó mở hoặc đang busy.
      onOpenChange={(o) => !o && !busy && !cascade && close()}
      dismissible={!busy && !cascade}
      className="sheet sheet-wide"
    >
      <div className="sheet-header">
        <DialogTitle className="sheet-title">
            {form.id ? (
              <>
                {readOnly ? t('assets.viewTitle', 'Xem') : t('assets.edit')} ·{' '}
                {initial.isSoftware ? (
                  initial.licenseName || t('assets.kindSoftware')
                ) : (
                  <span className="mono">{initial.code}</span>
                )}
              </>
            ) : lockSoftware || form.isSoftware ? (
              initial.licenseName
                ? `${t('software.addSeat')} · ${initial.licenseName}`
                : t('software.add')
            ) : (
              t('assets.addAsset')
            )}
          </DialogTitle>
          <span className="spacer" />
          <DialogClose asChild>
            <button
              type="button"
              className="sheet-close"
              aria-label={t('assets.cancel')}
              disabled={busy}
            >
              ✕
            </button>
          </DialogClose>
        </div>

        <form
          style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="sheet-body">
           <fieldset disabled={readOnly} className="ff-contents">
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

            {!form.id && !lockSoftware && (
              // chọn bản chất bản ghi khi TẠO — sửa không đổi được (TYPE_SOFTWARE_IMMUTABLE).
              // Form phần mềm thuần (lockSoftware) không hiện toggle (luôn là phần mềm).
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
                placeOptions={placeOptions}
                catConfig={catConfig}
                addConfig={addConfig}
                addingConfig={addingConfig}
                hideDatesNote={softwareCreate}
                userField={
                  // Người đứng tên (User) sửa NGAY trong Thông tin chung ở cả Thêm lẫn Sửa.
                  // Đổi/xóa người giữ đi qua "Lưu" — BE PUT máy tự ghi allocation_history khi
                  // assigned_user_sub đổi (assets.service §297), không cần panel Owner riêng.
                  !form.isSoftware ? (
                    form.assignedUserSub ? (
                      // Đã chọn → hiện TÊN ngay trong ô (như input đã điền) + ✕ để đổi.
                      <div className="picked-input">
                        <span className="pi-val">
                          {form.assignedUserName || form.assignedUserSub}
                        </span>
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
                      </div>
                    ) : (
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
                    )
                  ) : undefined
                }
                onDispose={async () => {
                  // Thanh lý KHÔNG đảo ngược → xác nhận trước, rồi preview cascade (AC2).
                  if (
                    !(await askConfirm({
                      title: t('assets.disposeConfirmTitle'),
                      message: t('assets.disposeConfirm'),
                      confirmLabel: t('assets.disposeAction'),
                      danger: true,
                    }))
                  )
                    return;
                  void previewThenRun(
                    'dispose',
                    'POST',
                    {},
                    {
                      status: 'disposed',
                      installedOnAssetId: '',
                      installedOnCode: '',
                    },
                  );
                }}
              />

            </div>

            {/* Mua nhiều bản chung 1 tên license (AutoCAD 20-30 bản) — "Số bản" = số dòng;
                mỗi bản nhập Start/End + Ghi chú RIÊNG, tất cả chưa gắn máy (gán sau). */}
            {softwareCreate && (
              <SoftwareSeatsFields
                seats={seats}
                setSeats={setSeats}
                isPerpetual={form.licenseType === 'perpetual'}
                isTerm={form.licenseType === 'term'}
              />
            )}

            {/* Người đứng tên đổi NGAY trong Thông tin chung (không còn panel Owner riêng);
                lưu qua nút "Lưu", BE tự ghi allocation_history khi assigned_user_sub đổi. */}

            {/* Vòng đời (Khóa sửa chữa / Pool) đã chuyển sang kebab của /tai-san (UAT).
                Form chỉ còn dispose qua dropdown Trạng thái. */}

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
           </fieldset>
          </div>

          <div className="sheet-footer">
            <span className="spacer" />
            <button type="button" disabled={busy} onClick={close}>
              {readOnly ? t('assets.close', 'Đóng') : t('assets.cancel')}
            </button>
            {/* disposed = hồ sơ đã chốt (F2) — server cũng chặn 409 DISPOSED_TERMINAL */}
            {!readOnly && (
              <button
                type="submit"
                className="primary"
                disabled={busy || (!!form.id && form.status === 'disposed')}
              >
                {busy && <span className="spinner" style={{ marginRight: 6 }} />}
                {t('assets.save')}
              </button>
            )}
          </div>
        </form>

      {/* 3.13: popup xác nhận cascade (Radix nested) — nằm TRÊN sheet, tự stack lớp Esc/outside. */}
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
    </Dialog>
  );
}

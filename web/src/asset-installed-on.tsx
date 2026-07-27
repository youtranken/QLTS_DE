import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from '@/combobox';
import type { AssetRow, FormState } from '@/asset-types';

/**
 * Khối "Cài trên máy" (installedOn) của PHẦN MỀM — chọn/đổi/gỡ máy chủ. Tách khỏi asset-form (§6).
 * Presentational: state + transfer (endpoint riêng 2.5) vẫn ở asset-form.
 */
export function AssetInstalledOn({
  form,
  setForm,
  busy,
  hostQuery,
  setHostQuery,
  hostOptions,
  setHostOptions,
  transfer,
}: {
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  busy: boolean;
  hostQuery: string;
  setHostQuery: (v: string) => void;
  hostOptions: AssetRow[];
  setHostOptions: Dispatch<SetStateAction<AssetRow[]>>;
  transfer: (target: { id: string; code: string } | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="form-section">
      <div className="form-section-title">{t('assets.installedOn')}</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: '0.6rem',
          flexWrap: 'wrap',
        }}
      >
        {form.installedOnAssetId ? (
          <span className="chip">
            {form.installedOnCode || form.installedOnAssetId}
            {!form.id && (
              <button
                type="button"
                aria-label={t('assets.cancel')}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    installedOnAssetId: '',
                    installedOnCode: '',
                  }))
                }
              >
                ✕
              </button>
            )}
          </span>
        ) : (
          <span className="muted">{t('assets.installedNone')}</span>
        )}
        {form.id && form.installedOnAssetId && (
          // 2.5: gỡ về "chưa gắn máy" — thao tác thật, có audit
          <button
            type="button"
            className="sm"
            disabled={busy}
            onClick={() => void transfer(null)}
          >
            {t('assets.detach')}
          </button>
        )}
      </div>
      {/* Bó hẹp bằng ô input thường (form rộng nhiều cột) — không kéo dài hết bề ngang sheet. */}
      <div style={{ maxWidth: 360 }}>
      <Combobox
        placeholder={
          form.id ? t('assets.transferToSearch') : t('assets.installedOnSearch')
        }
        query={hostQuery}
        onQuery={setHostQuery}
        options={hostOptions}
        disabled={busy}
        getKey={(a) => a.id}
        renderOption={(a) => (
          <>
            <span>{a.code}</span>
            <small>{a.type}</small>
          </>
        )}
        onSelect={(a) => {
          if (form.id) {
            // sửa: chuyển NGAY qua endpoint transfer (2.5). Host là MÁY → luôn có mã.
            void transfer({ id: a.id, code: a.code ?? '' });
            return;
          }
          setForm((f) => ({
            ...f,
            installedOnAssetId: a.id,
            installedOnCode: a.code ?? '',
          }));
          setHostQuery('');
          setHostOptions([]);
        }}
      />
      </div>
    </div>
  );
}

import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormState } from './asset-types';

export type LifecycleRun = (
  path: string,
  method: 'POST' | 'PUT',
  extra: Record<string, unknown>,
  patch: Partial<FormState>,
) => void;

/**
 * Khối "Vòng đời" (khóa/mở/pool/thanh lý) tách khỏi asset-form (§6). Presentational:
 * state + handler (doLifecycle/previewThenRun gọi endpoint riêng) vẫn ở asset-form — KHÔNG qua "Lưu".
 */
export function AssetLifecyclePanel({
  form,
  busy,
  showLockForm,
  setShowLockForm,
  lockReason,
  setLockReason,
  lockEta,
  setLockEta,
  doLifecycle,
  previewThenRun,
}: {
  form: FormState;
  busy: boolean;
  showLockForm: boolean;
  setShowLockForm: Dispatch<SetStateAction<boolean>>;
  lockReason: string;
  setLockReason: (v: string) => void;
  lockEta: string;
  setLockEta: (v: string) => void;
  doLifecycle: LifecycleRun;
  previewThenRun: LifecycleRun;
}) {
  const { t } = useTranslation();
  return (
    // 2.6: vòng đời — 3 thao tác tách bạch, không đi qua nút Lưu
    <div className="form-section">
      <div className="form-section-title">{t('assets.lifecycle')}</div>
      {form.status === 'disposed' ? (
        <p className="muted">{t('assets.disposedTerminal')}</p>
      ) : (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {!form.isSoftware && form.status === 'in_use' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowLockForm((v) => !v)}
            >
              {t('assets.lockAction')}
            </button>
          )}
          {!form.isSoftware && form.status === 'locked_repair' && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void doLifecycle('unlock', 'POST', {}, { status: 'in_use' })
              }
            >
              {t('assets.unlockAction')}
            </button>
          )}
          {!form.isSoftware && form.status === 'in_use' && (
            // pool toggle CHỈ khi in_use — đụng pool lúc đang khóa phá
            // invariant "mở khóa → pool như trước" (review 2.6)
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const next = !form.isPool;
                // Gỡ pool (next=false) → cascade → preview+popup; bật pool → chạy thẳng
                const run = next ? doLifecycle : previewThenRun;
                void run('pool', 'PUT', { isPool: next }, { isPool: next });
              }}
            >
              {form.isPool ? t('assets.poolOff') : t('assets.poolOn')}
            </button>
          )}
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              // Thanh lý không đảo ngược → giữ window.confirm (AC2); rồi preview+popup
              if (window.confirm(t('assets.disposeConfirm'))) {
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
              }
            }}
          >
            {t('assets.disposeAction')}
          </button>
        </div>
      )}
      {showLockForm && form.status === 'in_use' && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            marginTop: '0.75rem',
          }}
        >
          <label className="field">
            <span>
              {t('assets.lockReason')} <span className="field-req">*</span>
            </span>
            <input
              maxLength={500}
              value={lockReason}
              onChange={(e) => setLockReason(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('assets.lockEta')}</span>
            <input
              type="date"
              value={lockEta}
              onChange={(e) => setLockEta(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy || !lockReason.trim()}
            onClick={() =>
              void previewThenRun(
                'lock',
                'POST',
                {
                  reason: lockReason.trim(),
                  ...(lockEta ? { eta: lockEta } : {}),
                },
                { status: 'locked_repair' },
              )
            }
          >
            {t('assets.confirmLock')}
          </button>
        </div>
      )}
    </div>
  );
}

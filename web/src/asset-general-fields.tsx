import { useTranslation } from 'react-i18next';
import type { FormState } from './asset-types';

/**
 * Khối "Thông tin chung" (máy + trường license phần mềm) tách khỏi asset-form (§6).
 * Presentational: state ở asset-form; `set(key)(value)` là setter curry của form.
 */
export function AssetGeneralFields({
  form,
  set,
  typeOptions,
  brandOptions,
  catConfig,
  addConfig,
  addingConfig,
}: {
  form: FormState;
  set: (key: keyof FormState) => (value: string) => void;
  typeOptions: string[];
  brandOptions: string[];
  catConfig: string[];
  addConfig: () => void;
  addingConfig: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="form-grid">
      {/* Phần mềm định danh bằng Tên license → KHÔNG có Mã tài sản (sw-license-model-redesign) */}
      {!form.isSoftware && (
        <label className="field">
          <span>
            {t('assets.code')} <span className="field-req">*</span>
          </span>
          <input
            required
            maxLength={100}
            value={form.code}
            onChange={(e) => set('code')(e.target.value)}
          />
        </label>
      )}
      {!form.isSoftware && (
        <label className="field">
          <span>
            {t('assets.type')} <span className="field-req">*</span>
          </span>
          <select
            required
            value={form.type}
            onChange={(e) => set('type')(e.target.value)}
          >
            <option value="">—</option>
            {typeOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      )}
      {form.isSoftware && (
        <label className="field">
          <span>
            {t('assets.licenseType')} <span className="field-req">*</span>
          </span>
          <select
            required
            value={form.licenseType}
            onChange={(e) => set('licenseType')(e.target.value)}
          >
            <option value="">—</option>
            <option value="term">{t('assets.licenseTerm')}</option>
            <option value="perpetual">{t('assets.licensePerpetual')}</option>
          </select>
        </label>
      )}
      {/* Tên license: định danh phần mềm — BẮT BUỘC mọi license (không chỉ vĩnh viễn) */}
      {form.isSoftware && (
        <label className="field">
          <span>
            {t('assets.licenseName')} <span className="field-req">*</span>
          </span>
          <input
            required
            maxLength={200}
            value={form.licenseName}
            onChange={(e) => set('licenseName')(e.target.value)}
          />
        </label>
      )}
      {/* Cấu hình: chỉ dành cho máy — phần mềm không có (sw-license-model-redesign) */}
      {!form.isSoftware && (
        <label className="field span-2">
          <span>{t('assets.configuration')}</span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              list="catalog-config-list"
              maxLength={2000}
              style={{ flex: 1 }}
              value={form.configuration}
              onChange={(e) => set('configuration')(e.target.value)}
            />
            <datalist id="catalog-config-list">
              {catConfig.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <button
              type="button"
              className="sm"
              title={t('assets.configAdd')}
              disabled={
                addingConfig ||
                !form.configuration.trim() ||
                catConfig.includes(form.configuration.trim())
              }
              onClick={() => void addConfig()}
            >
              ＋
            </button>
          </div>
        </label>
      )}
      <label className="field">
        <span>{t('assets.cost')}</span>
        <input
          type="number"
          min={0}
          step={1}
          value={form.cost}
          onChange={(e) => set('cost')(e.target.value)}
        />
      </label>
      <label className="field">
        <span>{t('assets.startDate')}</span>
        <input
          type="date"
          value={form.startDate}
          onChange={(e) => set('startDate')(e.target.value)}
        />
      </label>
      {!(form.isSoftware && form.licenseType === 'perpetual') && (
        <label className="field">
          <span>
            {t('assets.endDate')}
            {form.isSoftware && form.licenseType === 'term' && (
              <span className="field-req"> *</span>
            )}
          </span>
          <input
            type="date"
            required={form.isSoftware && form.licenseType === 'term'}
            value={form.endDate}
            onChange={(e) => set('endDate')(e.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>{t('assets.statusLabel')}</span>
        {/* Chỉ hiển thị (AC 1) — khóa/gỡ pool/thanh lý là nghiệp vụ 2.6 */}
        <input disabled value={t(`assets.status.${form.status}`)} />
      </label>
      <label className="field">
        <span>{t('assets.serial')}</span>
        <input
          maxLength={200}
          value={form.serial}
          onChange={(e) => set('serial')(e.target.value)}
        />
      </label>
      <label className="field">
        <span>{t('assets.brand')}</span>
        <select
          value={form.brand}
          onChange={(e) => set('brand')(e.target.value)}
        >
          <option value="">—</option>
          {brandOptions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="field span-2">
        <span>{t('assets.note')}</span>
        <input
          maxLength={2000}
          value={form.note}
          onChange={(e) => set('note')(e.target.value)}
        />
      </label>
    </div>
  );
}

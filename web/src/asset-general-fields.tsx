import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatVnd, parseVnd } from './asset-types';
import type { FormState } from './asset-types';
import { DatePicker } from './ui/date-picker';

/**
 * Khối "Thông tin chung" (máy + trường license phần mềm) tách khỏi asset-form (§6).
 * Presentational: state ở asset-form; `set(key)(value)` là setter curry của form.
 * `onDispose`: khi SỬA + đang dùng, đổi Trạng thái sang "Thanh lý" chạy luồng thanh lý
 * (preview cascade) thay cho nút Vòng đời cũ.
 */
export function AssetGeneralFields({
  form,
  set,
  typeOptions,
  brandOptions,
  placeOptions,
  catConfig,
  addConfig,
  addingConfig,
  onDispose,
  userField,
  hideDatesNote = false,
}: {
  form: FormState;
  set: (key: keyof FormState) => (value: string) => void;
  typeOptions: string[];
  brandOptions: string[];
  placeOptions: string[];
  catConfig: string[];
  addConfig: () => void;
  addingConfig: boolean;
  onDispose?: () => void;
  /** Ô "User" (người đứng tên) nhúng trong grid khi TẠO máy — cùng hàng Code/Asset Type. */
  userField?: ReactNode;
  /** TẠO phần mềm nhiều bản: Start/End/Ghi chú chuyển sang nhập theo TỪNG bản (ẩn ở đây). */
  hideDatesNote?: boolean;
}) {
  const { t } = useTranslation();
  const isEditing = form.id != null;
  return (
    <div className="form-grid asset-grid">
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
      {/* User (người đứng tên) — cùng hàng Code/Asset Type khi TẠO máy. */}
      {userField && (
        <label className="field">
          <span>{t('assets.assignee')}</span>
          {userField}
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
      {/* Trạng thái ở HÀNG ĐẦU cạnh Code/Type (đủ 3 cột). Tạo mới luôn "Đang dùng" → ẩn.
          Sửa + đang dùng: đổi sang Thanh lý (chạy luồng thanh lý + preview cascade); khác → tĩnh. */}
      {isEditing && (
        <label className="field">
          <span>{t('assets.statusLabel')}</span>
          {form.status === 'in_use' && onDispose ? (
            <select
              value={form.status}
              onChange={(e) => {
                if (e.target.value === 'disposed') onDispose();
              }}
            >
              <option value="in_use">{t('assets.status.in_use')}</option>
              <option value="disposed">{t('assets.status.disposed')}</option>
            </select>
          ) : (
            <input disabled value={t(`assets.status.${form.status}`)} />
          )}
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
      {/* Giá: máy + sửa phần mềm dùng ô chung; TẠO phần mềm nhiều bản → Giá theo TỪNG bản. */}
      {!hideDatesNote && (
        <label className="field">
          <span>{t('assets.cost')}</span>
          {/* Giá VND hiển thị dấu chấm ngăn nghìn (5.000.000); state giữ số nguyên (parseVnd). */}
          <input
            type="text"
            inputMode="numeric"
            value={formatVnd(form.cost)}
            onChange={(e) => set('cost')(parseVnd(e.target.value))}
          />
        </label>
      )}
      {!hideDatesNote && (
      <label className="field">
        <span>{t('assets.startDate')}</span>
        <DatePicker
          value={form.startDate}
          ariaLabel={t('assets.startDate')}
          onChange={set('startDate')}
        />
      </label>
      )}
      {!hideDatesNote && !(form.isSoftware && form.licenseType === 'perpetual') && (
        <label className="field">
          <span>
            {t('assets.endDate')}
            {form.isSoftware && form.licenseType === 'term' && (
              <span className="field-req"> *</span>
            )}
          </span>
          {/* Hạn phải SAU ngày đưa vào dùng — min = ngày kế tiếp (loại trừ bằng nhau, khớp
              validate `endDate <= startDate` khi Lưu); asset-form validate lại lần cuối. */}
          <DatePicker
            value={form.endDate}
            ariaLabel={t('assets.endDate')}
            min={
              form.startDate
                ? new Date(new Date(form.startDate).getTime() + 86400000)
                    .toISOString()
                    .slice(0, 10)
                : undefined
            }
            onChange={set('endDate')}
          />
        </label>
      )}
      <label className="field">
        <span>{t('assets.serial')}</span>
        <input
          maxLength={200}
          value={form.serial}
          onChange={(e) => set('serial')(e.target.value)}
        />
      </label>
      {/* Place (vị trí đặt máy) — chỉ máy; dropdown từ danh mục (kind=place) + cho gõ tự do. */}
      {!form.isSoftware && (
        <label className="field">
          <span>{t('assets.floor')}</span>
          <input
            list="catalog-place-list"
            maxLength={200}
            value={form.floor}
            onChange={(e) => set('floor')(e.target.value)}
          />
          <datalist id="catalog-place-list">
            {placeOptions.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </label>
      )}
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
      {!hideDatesNote && (
      <label className="field span-2">
        <span>{t('assets.note')}</span>
        <input
          maxLength={2000}
          value={form.note}
          onChange={(e) => set('note')(e.target.value)}
        />
      </label>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/ui/select';

/**
 * Ô "Tên license" cho form phần mềm — mặc định là DROPDOWN chọn (Select có mũi tên, đồng bộ
 * License Type) từ danh mục kind=licenseName. Nút ＋ chuyển sang ô gõ để thêm TÊN MỚI (POST
 * vào danh mục), rồi quay lại dropdown. Khi "Thêm bản" vào license có sẵn (locked) → ô khóa.
 */
export function LicenseNameField({
  value,
  onChange,
  options,
  onAdd,
  adding,
  locked,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  /** Thêm `value` hiện tại vào danh mục (kind=licenseName). */
  onAdd: () => void;
  /** Đang POST thêm danh mục. */
  adding: boolean;
  /** "Thêm bản": tên cố định theo license → khóa. */
  locked: boolean;
}) {
  const { t } = useTranslation();
  const [newMode, setNewMode] = useState(false);

  if (locked) {
    return <input required maxLength={200} disabled value={value} />;
  }

  if (newMode) {
    const v = value.trim();
    return (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          autoFocus
          required
          maxLength={200}
          style={{ flex: 1 }}
          placeholder={t('assets.licenseNameNew', 'Nhập tên license mới…')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="sm primary"
          title={t('assets.licenseNameAdd', 'Thêm vào danh mục')}
          disabled={adding || !v || options.includes(v)}
          onClick={() => {
            onAdd();
            setNewMode(false);
          }}
        >
          ＋
        </button>
        <button
          type="button"
          className="sm"
          title={t('assets.cancel', 'Hủy')}
          onClick={() => setNewMode(false)}
        >
          ↩
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Select
          ariaLabel={t('assets.licenseName')}
          value={value}
          onChange={onChange}
          placeholder={t('assets.licenseNamePick', '— Chọn tên license —')}
          options={options.map((o) => ({ value: o, label: o }))}
        />
      </div>
      <button
        type="button"
        className="sm"
        title={t('assets.licenseNameNewBtn', 'Thêm tên license mới')}
        onClick={() => {
          onChange('');
          setNewMode(true);
        }}
      >
        ＋
      </button>
    </div>
  );
}

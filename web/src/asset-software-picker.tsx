import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import type { AssetRow } from './asset-types';

export interface InstalledSoftwareRow {
  id: string;
  code: string | null;
  licenseType: string | null;
  licenseName: string | null;
  endDate: string | null;
}

/**
 * Khối "Software đã cài" của MÁY, tách khỏi asset-form (§6) — story 11.2 follow-up (UAT B3/software).
 * Trình bày thuần: state + handler vẫn ở asset-form (attach/detach gọi endpoint riêng, KHÔNG qua "Lưu máy").
 * - isCreate=true: chọn phần mềm gắn SAU khi tạo máy (pendingSw).
 * - isCreate=false: máy đã tồn tại → list phần mềm đang cài + gắn/gỡ ngay (moveSoftware).
 */
export function AssetSoftwarePicker({
  isCreate,
  busy,
  swQuery,
  setSwQuery,
  swOptions,
  pendingSw,
  setPendingSw,
  installedSoftware,
  moveSoftware,
  machineId,
}: {
  isCreate: boolean;
  busy: boolean;
  swQuery: string;
  setSwQuery: (v: string) => void;
  swOptions: AssetRow[];
  pendingSw: AssetRow[];
  setPendingSw: Dispatch<SetStateAction<AssetRow[]>>;
  installedSoftware: InstalledSoftwareRow[];
  moveSoftware: (swId: string, target: string | null) => void;
  machineId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="form-section">
      <div className="form-section-title">{t('assets.installedSoftware')}</div>
      {isCreate ? (
        <>
          {pendingSw.length > 0 && (
            <div className="swpick" style={{ marginBottom: '0.6rem' }}>
              {pendingSw.map((s) => (
                <span className="swchip" key={s.id}>
                  {s.licenseName ?? s.code}
                  <button
                    type="button"
                    aria-label={t('assets.detachSoftware')}
                    onClick={() =>
                      setPendingSw((prev) => prev.filter((x) => x.id !== s.id))
                    }
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <Combobox
            placeholder={t('assets.attachSoftwareSearch')}
            query={swQuery}
            onQuery={setSwQuery}
            options={swOptions.filter(
              (o) => !pendingSw.some((p) => p.id === o.id),
            )}
            disabled={busy}
            getKey={(a) => a.id}
            renderOption={(a) => (
              <>
                <span>{a.licenseName ?? a.code}</span>
                <small>{t('assets.kindSoftware')}</small>
              </>
            )}
            onSelect={(a) => {
              setPendingSw((prev) => [...prev, a]);
              setSwQuery('');
            }}
          />
        </>
      ) : (
        <>
          {installedSoftware.length === 0 ? (
            <p className="muted" style={{ margin: '0 0 0.6rem' }}>
              {t('assets.installedSoftwareNone')}
            </p>
          ) : (
            <ul style={{ margin: '0 0 0.6rem', paddingLeft: '1.25rem' }}>
              {installedSoftware.map((s) => (
                <li key={s.id}>
                  {s.licenseName ?? s.code}
                  {s.licenseType === 'perpetual'
                    ? ` (${t('assets.licensePerpetual')})`
                    : s.endDate
                      ? ` — ${t('assets.endDate')}: ${s.endDate}`
                      : ''}{' '}
                  <button
                    type="button"
                    className="ghost sm"
                    disabled={busy}
                    onClick={() => void moveSoftware(s.id, null)}
                  >
                    {t('assets.detachSoftware')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* 9.4: gắn nhanh phần mềm đã có vào máy này (tạo mới ở tab Phần mềm). */}
          <Combobox
            placeholder={t('assets.attachSoftwareSearch')}
            query={swQuery}
            onQuery={setSwQuery}
            options={swOptions}
            disabled={busy}
            getKey={(a) => a.id}
            renderOption={(a) => (
              <>
                <span>{a.licenseName ?? a.code}</span>
                <small>{t('assets.kindSoftware')}</small>
              </>
            )}
            onSelect={(a) => void moveSoftware(a.id, machineId)}
          />
        </>
      )}
    </div>
  );
}

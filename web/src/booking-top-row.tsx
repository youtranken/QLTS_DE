import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import type { FreeMachine, UserOption } from './booking-types';

/**
 * Hàng trên popup Đặt máy: Người mượn (chỉ admin, tạo hộ) + Máy trên CÙNG 1 hàng.
 * Máy hiển thị chip + "Đổi máy" → dropdown chọn máy khác trong pool. Thuần trình bày.
 */
export interface BookingTopRowProps {
  isAdmin: boolean;
  borrower: UserOption | null;
  setBorrower: (v: UserOption | null) => void;
  userQuery: string;
  setUserQuery: (v: string) => void;
  userOptions: UserOption[];
  setUserOptions: (v: UserOption[]) => void;
  assetId: string;
  setAssetId: (v: string) => void;
  poolList: FreeMachine[];
  selected: FreeMachine | null;
  editMachine: boolean;
  setEditMachine: (v: boolean) => void;
}

export function BookingTopRow({
  isAdmin,
  borrower,
  setBorrower,
  userQuery,
  setUserQuery,
  userOptions,
  setUserOptions,
  assetId,
  setAssetId,
  poolList,
  selected,
  editMachine,
  setEditMachine,
}: BookingTopRowProps) {
  const { t } = useTranslation();
  return (
    <div className="sheet-toprow">
      {isAdmin && (
        <div className="topcell">
          <span className="topcell-label">{t('bookingSheet.borrower')}</span>
          {borrower ? (
            <span className="chip">
              {borrower.fullName ?? borrower.sub}
              <button
                type="button"
                aria-label={t('bookingSheet.close')}
                onClick={() => setBorrower(null)}
              >
                ✕
              </button>
            </span>
          ) : (
            <Combobox
              placeholder={t('bookingSheet.borrowerSearch')}
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
                setBorrower(u);
                setUserQuery('');
                setUserOptions([]);
              }}
            />
          )}
        </div>
      )}
      <div className="topcell">
        <span className="topcell-label">{t('bookingSheet.machine', 'Máy')}</span>
        {editMachine || !selected ? (
          <select
            className="machine-select"
            value={assetId}
            onChange={(e) => {
              setAssetId(e.target.value);
              if (e.target.value) setEditMachine(false);
            }}
          >
            <option value="">
              {t('bookingSheet.pickMachine', '— Chọn máy —')}
            </option>
            {poolList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} · {m.type}
                {m.configuration ? ` · ${m.configuration}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <div className="picked-machine compact">
            <span className="pm-ico">🖥️</span>
            <div className="pm-info">
              <span className="mono pm-code">{selected.code}</span>
              <span className="muted pm-spec">
                {selected.type}
                {selected.configuration ? ` · ${selected.configuration}` : ''}
              </span>
            </div>
            <button
              type="button"
              className="ghost sm"
              onClick={() => setEditMachine(true)}
            >
              {t('bookingSheet.changeMachine', 'Đổi máy')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

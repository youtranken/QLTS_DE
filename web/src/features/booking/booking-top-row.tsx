import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from '@/ui/combobox';
import { AssetTypeIcon } from '@/ui/asset-type-icon';
import type { FreeMachine, UserOption } from '@/features/booking/booking-types';

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
  setAssetId,
  poolList,
  selected,
  editMachine,
  setEditMachine,
}: BookingTopRowProps) {
  const { t } = useTranslation();
  // Chọn máy: combobox kiêm DROPDOWN — chưa gõ thì bung sẵn cả pool để chọn nhanh; gõ thì
  // lọc theo mã/loại/cấu hình. Giới hạn 50 dòng để menu không quá dài.
  const [machineQuery, setMachineQuery] = useState('');
  const q = machineQuery.trim().toLowerCase();
  const machineOptions = (
    q
      ? poolList.filter((m) =>
          `${m.code} ${m.type} ${m.configuration ?? ''}`.toLowerCase().includes(q),
        )
      : poolList
  ).slice(0, 50);
  return (
    <div className="sheet-toprow">
      {isAdmin && (
        <div className="topcell">
          <span className="topcell-label">{t('bookingSheet.borrower')}</span>
          {borrower ? (
            <div className="picked-input">
              <span className="pi-val">{borrower.fullName ?? borrower.sub}</span>
              <button
                type="button"
                aria-label={t('bookingSheet.close')}
                onClick={() => setBorrower(null)}
              >
                ✕
              </button>
            </div>
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
          <Combobox
            placeholder={t('bookingSheet.pickMachine', '— Chọn máy —')}
            query={machineQuery}
            onQuery={setMachineQuery}
            options={machineOptions}
            getKey={(m) => m.id}
            renderOption={(m) => (
              <>
                <span className="mono">{m.code}</span>
                <small>
                  {m.type}
                  {m.configuration ? ` · ${m.configuration}` : ''}
                </small>
              </>
            )}
            onSelect={(m) => {
              setAssetId(m.id);
              setEditMachine(false);
              setMachineQuery('');
            }}
          />
        ) : (
          <div className="picked-machine compact">
            <AssetTypeIcon type={selected.type} />
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

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api-client';
import { AssetForm } from './asset-form';
import { RowActionsMenu } from './asset-row-actions';
import { SoftwareTransferDialog } from './software-transfer-dialog';
import { EMPTY_FORM, STATUS_BADGE } from './asset-types';
import type { AssetRow } from './asset-types';
import type { Me } from './panels';

/** 1 dòng = 1 tên license (nhiều bản/seat gộp lại) — đếm bản/đã gắn/còn dư/sắp hết hạn. */
interface LicenseGroup {
  licenseName: string;
  licenseType: string | null;
  total: number;
  assigned: number;
  free: number;
  expiring: number;
  nextExpiry: string | null;
}

/**
 * Trang "Phần mềm" GOM NHÓM theo tên license (1 license mua nhiều bản, mỗi bản máy/hạn riêng).
 * Click 1 nhóm → trang chi tiết liệt kê từng bản (seat) + gắn/chuyển máy. Nhóm CÓ NHIỀU BẢN
 * (≥2) hiện mũi tên ▸ bung nhanh danh sách bản đang gán (Máy/User/Start/End/Status).
 */
export function SoftwareGroupsPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<typeof EMPTY_FORM | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seatsByLicense, setSeatsByLicense] = useState<
    Record<string, AssetRow[] | 'loading'>
  >({});
  const [transferSw, setTransferSw] = useState<AssetRow | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data, isError } = useQuery({
    queryKey: ['software-groups', search],
    queryFn: () => {
      const qs = search ? `?search=${encodeURIComponent(search)}` : '';
      return apiFetch<LicenseGroup[]>(`/api/admin/assets/software-groups${qs}`);
    },
    placeholderData: (prev) => prev,
  });
  const groups = data ?? [];

  const toggle = async (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    if (seatsByLicense[name]) return; // đã tải (cache) — không gọi lại
    setSeatsByLicense((p) => ({ ...p, [name]: 'loading' }));
    try {
      const body = await apiFetch<{ items: AssetRow[] }>(
        `/api/admin/assets?type=software&licenseName=${encodeURIComponent(name)}&pageSize=100`,
      );
      setSeatsByLicense((p) => ({ ...p, [name]: body.items }));
    } catch {
      setSeatsByLicense((p) => ({ ...p, [name]: [] }));
    }
  };

  const termOf = (row: AssetRow) =>
    row.licenseType === 'perpetual'
      ? t('assets.licensePerpetual')
      : (row.endDate ?? '—');

  return (
    <>
      <div className="page-header">
        <h1>{t('software.title')}</h1>
        <a
          className="linkbtn"
          href={`/api/admin/assets/export-software${
            search ? `?search=${encodeURIComponent(search)}` : ''
          }`}
        >
          {t('assets.exportExcel')}
        </a>
        <button
          type="button"
          className="primary"
          onClick={() => setForm({ ...EMPTY_FORM, isSoftware: true })}
        >
          {t('software.add')}
        </button>
      </div>
      {isError && <p className="alert error">{t('assets.loadFailed')}</p>}
      <div className="filter-bar">
        <input
          className="grow search"
          placeholder={t('software.searchGroup')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '2.2rem' }} />
              <th>{t('assets.licenseName')}</th>
              <th>{t('assets.licenseType')}</th>
              <th className="num">{t('software.colTotal')}</th>
              <th className="num">{t('software.colAssigned')}</th>
              <th className="num">{t('software.colFree')}</th>
              <th className="num">{t('software.colExpiring')}</th>
              <th>{t('software.colNextExpiry')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty">
                  {search ? t('assets.noMatch') : t('software.empty')}
                </td>
              </tr>
            ) : (
              groups.map((g) => {
                const canExpand = g.total > 1;
                const isOpen = expanded.has(g.licenseName);
                const seats = seatsByLicense[g.licenseName];
                return [
                  <tr
                    key={g.licenseName}
                    className="clickable"
                    onClick={() =>
                      navigate(
                        `/phan-mem/license/${encodeURIComponent(g.licenseName)}`,
                      )
                    }
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      {canExpand && (
                        <button
                          type="button"
                          className="ghost sm"
                          aria-label={isOpen ? 'Thu gọn' : 'Mở rộng'}
                          onClick={() => void toggle(g.licenseName)}
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                      )}
                    </td>
                    <td>{g.licenseName}</td>
                    <td>
                      {g.licenseType === 'term'
                        ? t('assets.licenseTerm')
                        : g.licenseType === 'perpetual'
                          ? t('assets.licensePerpetual')
                          : '—'}
                    </td>
                    <td className="num">{g.total}</td>
                    <td className="num">{g.assigned}</td>
                    <td className="num">
                      {g.free > 0 ? (
                        <span className="badge ok plain">{g.free}</span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td className="num">
                      {g.expiring > 0 ? (
                        <span className="badge warn">{g.expiring}</span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td>
                      {g.licenseType === 'perpetual' ? '—' : (g.nextExpiry ?? '—')}
                    </td>
                  </tr>,
                  canExpand && isOpen ? (
                    <tr key={`${g.licenseName}-seats`}>
                      <td />
                      <td colSpan={7}>
                        {seats === 'loading' || seats === undefined ? (
                          <span className="muted">…</span>
                        ) : seats.length === 0 ? (
                          <span className="muted">{t('software.empty')}</span>
                        ) : (
                          <table className="table">
                            <thead>
                              <tr>
                                <th>{t('assets.hostCol')}</th>
                                <th>{t('assets.assignee')}</th>
                                <th>{t('assets.startDate')}</th>
                                <th>{t('assets.endDate')}</th>
                                <th>{t('assets.statusLabel')}</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {seats.map((s) => (
                                <tr
                                  key={s.id}
                                  className="clickable"
                                  onClick={() =>
                                    navigate(
                                      `/phan-mem/license/${encodeURIComponent(g.licenseName)}?seat=${s.id}`,
                                    )
                                  }
                                >
                                  <td>
                                    {s.installedOnCode ? (
                                      <span className="mono">
                                        {s.installedOnCode}
                                      </span>
                                    ) : (
                                      <span className="muted">
                                        {t('assets.installedNone')}
                                      </span>
                                    )}
                                  </td>
                                  <td>
                                    {s.assignedUserName ??
                                      s.assignedUserSub ??
                                      '—'}
                                  </td>
                                  <td>{s.startDate ?? '—'}</td>
                                  <td>{termOf(s)}</td>
                                  <td>
                                    <span
                                      className={`badge ${STATUS_BADGE[s.status] ?? 'muted'}`}
                                    >
                                      {t(`assets.status.${s.status}`)}
                                    </span>
                                  </td>
                                  <td onClick={(e) => e.stopPropagation()}>
                                    <RowActionsMenu
                                      actions={[
                                        {
                                          label: t('software.assignMachine'),
                                          onClick: () => setTransferSw(s),
                                        },
                                      ]}
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  ) : null,
                ];
              })
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <AssetForm
          me={me}
          initial={form}
          lockSoftware
          onDone={(saved) => {
            setForm(null);
            if (saved) {
              // Tạo thêm bản → tổng/seat đổi: refetch nhóm + xoá cache seat đã bung.
              void queryClient.invalidateQueries({ queryKey: ['software-groups'] });
              setSeatsByLicense({});
              setExpanded(new Set());
            }
          }}
        />
      )}

      {transferSw && (
        <SoftwareTransferDialog
          me={me}
          softwareId={transferSw.id}
          currentHostCode={transferSw.installedOnCode}
          onDone={(changed) => {
            setTransferSw(null);
            if (changed) {
              void queryClient.invalidateQueries({ queryKey: ['software-groups'] });
              setSeatsByLicense({});
              setExpanded(new Set());
            }
          }}
        />
      )}
    </>
  );
}

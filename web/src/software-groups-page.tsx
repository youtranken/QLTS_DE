import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api-client';
import { AssetForm } from './asset-form';
import { RowActionsMenu } from './asset-row-actions';
import { SoftwareTransferDialog } from './software-transfer-dialog';
import { EMPTY_FORM } from './asset-types';
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
  holders: number;
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

  // Tải seats (nếu chưa) rồi mở dialog gắn máy cho MỘT bản còn trống.
  const loadSeats = async (name: string): Promise<AssetRow[]> => {
    const cached = seatsByLicense[name];
    if (cached && cached !== 'loading') return cached;
    const body = await apiFetch<{ items: AssetRow[] }>(
      `/api/admin/assets?type=software&licenseName=${encodeURIComponent(name)}&pageSize=100`,
    );
    setSeatsByLicense((p) => ({ ...p, [name]: body.items }));
    return body.items;
  };
  const assignMachine = async (name: string) => {
    try {
      const seats = await loadSeats(name);
      const free = seats.find((s) => !s.installedOnCode && s.status !== 'disposed');
      if (free) setTransferSw(free);
    } catch {
      /* lỗi tải seats — bỏ qua, user thử lại */
    }
  };

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
              <th>{t('assets.licenseName')}</th>
              <th>{t('assets.licenseType')}</th>
              <th>{t('software.colTotal')}</th>
              <th>{t('software.colAssigned')}</th>
              <th>{t('software.colHolders')}</th>
              <th className="right">{t('software.colAction')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  {search ? t('assets.noMatch') : t('software.empty')}
                </td>
              </tr>
            ) : (
              groups.map((g) => {
                const isOpen = expanded.has(g.licenseName);
                const seats = seatsByLicense[g.licenseName];
                const ratio = g.total > 0 ? g.assigned / g.total : 0;
                const tone = ratio >= 0.8 ? 'high' : '';
                return [
                  <tr
                    key={g.licenseName}
                    className={`sw-lic-row${isOpen ? ' open' : ''}`}
                    onClick={() => void toggle(g.licenseName)}
                  >
                    <td>
                      <div className="sw-name">
                        <span className="sw-caret" aria-hidden="true">
                          ›
                        </span>
                        <span className="sw-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" rx="1.5" />
                            <rect x="14" y="3" width="7" height="7" rx="1.5" />
                            <rect x="14" y="14" width="7" height="7" rx="1.5" />
                            <rect x="3" y="14" width="7" height="7" rx="1.5" />
                          </svg>
                        </span>
                        <div>
                          <div className="sw-nm">{g.licenseName}</div>
                          {g.expiring > 0 ? (
                            <div className="sw-sub warn">
                              {t('software.expiringN', {
                                n: g.expiring,
                                defaultValue: '{{n}} bản sắp hết hạn',
                              })}
                            </div>
                          ) : g.licenseType !== 'perpetual' && g.nextExpiry ? (
                            <div className="sw-sub">
                              {t('software.nextExpiryShort', {
                                d: g.nextExpiry,
                                defaultValue: 'Hạn gần nhất {{d}}',
                              })}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      {g.licenseType === 'term' ? (
                        <span className="badge warn">{t('assets.licenseTerm')}</span>
                      ) : g.licenseType === 'perpetual' ? (
                        <span className="badge ok">{t('assets.licensePerpetual')}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <strong>{g.total}</strong>
                    </td>
                    <td>
                      <div className="seat-cell">
                        <div className="seat-val">
                          {g.assigned}
                          <small>/{g.total}</small>
                        </div>
                        <div className="seat-bar">
                          <span
                            className={tone}
                            style={{ width: `${Math.min(100, ratio * 100)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="sw-holders">
                      {t('software.holdersVal', {
                        machines: g.assigned,
                        people: g.holders,
                        defaultValue: '{{machines}} máy / {{people}} người',
                      })}
                    </td>
                    <td className="right" onClick={(e) => e.stopPropagation()}>
                      <div className="sw-row-actions">
                        <button
                          type="button"
                          className="sm"
                          disabled={g.free === 0}
                          onClick={() => void assignMachine(g.licenseName)}
                        >
                          {t('software.assignMachine')}
                        </button>
                        <RowActionsMenu
                          actions={[
                            {
                              label: t('software.detail', 'Xem chi tiết'),
                              onClick: () =>
                                navigate(
                                  `/phan-mem/license/${encodeURIComponent(g.licenseName)}`,
                                ),
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>,
                  isOpen ? (
                    <tr key={`${g.licenseName}-inst`} className="sw-detail-row">
                      <td colSpan={6}>
                        <div className="sw-detail-wrap">
                          {seats === 'loading' || seats === undefined ? (
                            <span className="muted">…</span>
                          ) : (
                            (() => {
                              const installed = seats.filter(
                                (s) => s.installedOnCode,
                              );
                              return (
                                <>
                                  <div className="sw-detail-head">
                                    {t('software.installedTitle', {
                                      n: installed.length,
                                      defaultValue: 'Máy đang cài ({{n}})',
                                    })}
                                  </div>
                                  {installed.length === 0 ? (
                                    <div className="sw-detail-empty">
                                      {t('software.notInstalled', 'Chưa cài trên máy nào.')}
                                    </div>
                                  ) : (
                                    installed.map((s) => (
                                      <div className="inst" key={s.id}>
                                        <div className="inst-mc">
                                          <span className="mono">
                                            {s.installedOnCode}
                                          </span>
                                          <small>{termOf(s)}</small>
                                        </div>
                                        <div className="inst-who">
                                          {s.assignedUserName ??
                                            s.assignedUserSub ??
                                            '—'}
                                        </div>
                                        <div className="inst-day">
                                          {s.startDate ?? '—'}
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </>
                              );
                            })()
                          )}
                        </div>
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

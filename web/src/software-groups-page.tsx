import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api-client';
import { AssetForm } from './asset-form';
import { RowActionsMenu } from './asset-row-actions';
import { SoftwareTransferDialog } from './software-transfer-dialog';
import { SoftwareSeatList } from './software-seat-list';
import { ConfirmDialog } from './confirm-dialog';
import { DatePicker } from './ui/date-picker';
import { detachSeat, disposeSeat } from './software-seat-ops';
import {
  EMPTY_FORM,
  detailToForm,
  formatDmy,
  daysUntil,
  EXPIRY_SOON_DAYS,
} from './asset-types';
import type { AssetDetail, AssetRow, FormState } from './asset-types';
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

const PAGE_SIZES = [10, 20, 50, 100];

/**
 * Trang "Phần mềm" GOM NHÓM theo tên license (software.html). Click 1 nhóm → bung danh sách
 * TỪNG bản (seat) với cột Máy/User/Start/End/Ghi chú + action mỗi bản (Sửa/Gỡ/Thanh lý) và
 * ghế trống (Gắn vào máy). Phân trang + lọc hạn client-side. Người giữ derive theo máy.
 */
export function SoftwareGroupsPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [endFrom, setEndFrom] = useState('');
  const [endTo, setEndTo] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [viewForm, setViewForm] = useState<FormState | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seatsByLicense, setSeatsByLicense] = useState<
    Record<string, AssetRow[] | 'loading'>
  >({});
  const [transferSw, setTransferSw] = useState<AssetRow | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: 'detach' | 'dispose';
    seat: AssetRow;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

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

  // Lọc theo hạn (nextExpiry) + phân trang client-side (endpoint trả cả danh sách).
  const filtered = useMemo(() => {
    if (!endFrom && !endTo) return groups;
    return groups.filter((g) => {
      if (!g.nextExpiry) return false; // vĩnh viễn / chưa có hạn → loại khi lọc theo ngày
      if (endFrom && g.nextExpiry < endFrom) return false;
      if (endTo && g.nextExpiry > endTo) return false;
      return true;
    });
  }, [groups, endFrom, endTo]);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageGroups = filtered.slice((page - 1) * pageSize, page * pageSize);

  // Đổi bộ lọc/kích thước trang → về trang 1 (tránh rơi ra ngoài phạm vi).
  useEffect(() => {
    setPage(1);
  }, [search, endFrom, endTo, pageSize]);

  const seatsUrl = (name: string) =>
    `/api/admin/assets?type=software&licenseName=${encodeURIComponent(name)}&excludeDisposed=true&pageSize=100`;

  const loadSeats = async (name: string): Promise<AssetRow[]> => {
    const cached = seatsByLicense[name];
    if (cached && cached !== 'loading') return cached;
    const body = await apiFetch<{ items: AssetRow[] }>(seatsUrl(name));
    setSeatsByLicense((p) => ({ ...p, [name]: body.items }));
    return body.items;
  };
  const reloadSeats = async (name: string) => {
    try {
      const body = await apiFetch<{ items: AssetRow[] }>(seatsUrl(name));
      setSeatsByLicense((p) => ({ ...p, [name]: body.items }));
    } catch {
      /* giữ nguyên cache cũ nếu tải lại lỗi */
    }
  };

  const toggle = async (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    if (seatsByLicense[name]) return;
    setSeatsByLicense((p) => ({ ...p, [name]: 'loading' }));
    try {
      const body = await apiFetch<{ items: AssetRow[] }>(seatsUrl(name));
      setSeatsByLicense((p) => ({ ...p, [name]: body.items }));
    } catch {
      setSeatsByLicense((p) => ({ ...p, [name]: [] }));
    }
  };

  const assignMachine = async (name: string) => {
    try {
      const seats = await loadSeats(name);
      const seat = seats.find((s) => !s.installedOnCode && s.status !== 'disposed');
      if (seat) setTransferSw(seat);
    } catch {
      /* lỗi tải seats — bỏ qua */
    }
  };

  // Mở form (Sửa) / popup xem read-only cho 1 bản: lấy detail tươi rồi map sang FormState.
  const openSeat = async (seat: AssetRow, mode: 'edit' | 'view') => {
    setActionErr(null);
    try {
      const res = await fetch(`/api/admin/assets/${encodeURIComponent(seat.id)}`);
      if (!res.ok) {
        setActionErr(t('assets.loadFailed'));
        return;
      }
      const f = detailToForm((await res.json()) as AssetDetail);
      if (mode === 'edit') setForm(f);
      else setViewForm(f);
    } catch {
      setActionErr(t('app.serverUnreachable'));
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { kind, seat } = confirm;
    setConfirmBusy(true);
    setActionErr(null);
    const r =
      kind === 'detach'
        ? await detachSeat(seat.id, me.csrfToken)
        : await disposeSeat(seat.id, me.csrfToken);
    setConfirmBusy(false);
    setConfirm(null);
    if (r.ok) {
      if (seat.licenseName) await reloadSeats(seat.licenseName);
      void queryClient.invalidateQueries({ queryKey: ['software-groups'] });
    } else {
      setActionErr(r.message ?? t('assets.saveFailed'));
    }
  };

  const afterFormDone = (saved: boolean) => {
    setForm(null);
    if (saved) {
      void queryClient.invalidateQueries({ queryKey: ['software-groups'] });
      setSeatsByLicense({});
      setExpanded(new Set());
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
      {(isError || actionErr) && (
        <p className="alert error">{actionErr ?? t('assets.loadFailed')}</p>
      )}
      <div className="filter-bar">
        <input
          className="grow search"
          placeholder={t('software.searchGroup')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <label className="field-inline">
          <span className="muted">{t('assets.endFrom', 'Hết hạn từ')}</span>
          <DatePicker
            value={endFrom}
            max={endTo || undefined}
            ariaLabel={t('assets.endFrom', 'Hết hạn từ')}
            onChange={setEndFrom}
          />
        </label>
        <label className="field-inline">
          <span className="muted">{t('assets.endTo', 'đến')}</span>
          <DatePicker
            value={endTo}
            min={endFrom || undefined}
            ariaLabel={t('assets.endTo', 'đến')}
            onChange={setEndTo}
          />
        </label>
        {(endFrom || endTo) && (
          <button
            type="button"
            onClick={() => {
              setEndFrom('');
              setEndTo('');
            }}
          >
            {t('assets.clearFilters')}
          </button>
        )}
        <select
          className="page-size"
          aria-label={t('software.pageSize', 'Số dòng mỗi trang')}
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {t('software.perPage', '{{n}}/trang', { n })}
            </option>
          ))}
        </select>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '3rem' }}>#</th>
              <th>{t('software.hdrSoftware', 'Software')}</th>
              <th>{t('software.hdrLicense', 'License')}</th>
              <th>{t('software.colTotal')}</th>
              <th>{t('software.colAssigned')}</th>
              <th>{t('software.colHolders')}</th>
              <th className="right">{t('software.colAction')}</th>
            </tr>
          </thead>
          <tbody>
            {pageGroups.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  {search || endFrom || endTo
                    ? t('assets.noMatch')
                    : t('software.empty')}
                </td>
              </tr>
            ) : (
              pageGroups.map((g, i) => {
                const isOpen = expanded.has(g.licenseName);
                const stt = (page - 1) * pageSize + i + 1;
                const seats = seatsByLicense[g.licenseName];
                const ratio = g.total > 0 ? g.assigned / g.total : 0;
                const tone = ratio >= 1 ? 'full' : ratio >= 0.8 ? 'high' : '';
                return [
                  <tr
                    key={g.licenseName}
                    className={`sw-lic-row${isOpen ? ' open' : ''}`}
                    onClick={() => void toggle(g.licenseName)}
                  >
                    <td className="muted">{stt}</td>
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
                          {(() => {
                            const exp = g.nextExpiry;
                            const n =
                              exp && g.licenseType !== 'perpetual'
                                ? daysUntil(exp)
                                : NaN;
                            // Hạn gần nhất ≤30 ngày (hoặc quá hạn) → đỏ nhấp nháy + đếm ngược.
                            if (exp && Number.isFinite(n) && n <= EXPIRY_SOON_DAYS) {
                              return (
                                <div className="sw-sub due-over">
                                  {t('software.nextExpiryShort', {
                                    d: formatDmy(exp),
                                    defaultValue: 'Hạn gần nhất {{d}}',
                                  })}{' '}
                                  ·{' '}
                                  {n < 0
                                    ? t('software.overdueDays', {
                                        n: Math.abs(n),
                                        defaultValue: 'quá hạn {{n}} ngày',
                                      })
                                    : t('software.daysLeft', {
                                        n,
                                        defaultValue: 'còn {{n}} ngày',
                                      })}
                                </div>
                              );
                            }
                            if (g.expiring > 0) {
                              return (
                                <div className="sw-sub warn">
                                  {t('software.expiringN', {
                                    n: g.expiring,
                                    defaultValue: '{{n}} bản sắp hết hạn',
                                  })}
                                </div>
                              );
                            }
                            if (exp && g.licenseType !== 'perpetual') {
                              return (
                                <div className="sw-sub">
                                  {t('software.nextExpiryShort', {
                                    d: formatDmy(exp),
                                    defaultValue: 'Hạn gần nhất {{d}}',
                                  })}
                                </div>
                              );
                            }
                            return null;
                          })()}
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
                              onClick: () => void toggle(g.licenseName),
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>,
                  isOpen ? (
                    <tr key={`${g.licenseName}-inst`} className="sw-detail-row">
                      <td colSpan={7}>
                        <div className="sw-detail-wrap">
                          {seats === 'loading' || seats === undefined ? (
                            <span className="muted">…</span>
                          ) : (
                            <SoftwareSeatList
                              seats={seats}
                              onView={(s) => void openSeat(s, 'view')}
                              onEdit={(s) => void openSeat(s, 'edit')}
                              onDetach={(s) => setConfirm({ kind: 'detach', seat: s })}
                              onDispose={(s) => setConfirm({ kind: 'dispose', seat: s })}
                              onAssign={(s) => setTransferSw(s)}
                            />
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

      {total > pageSize && (
        <div className="sw-pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ‹ {t('assets.prev')}
          </button>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {t('assets.pageOf', { page, totalPages, total })}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('assets.next')} ›
          </button>
        </div>
      )}

      {form && <AssetForm me={me} initial={form} lockSoftware onDone={afterFormDone} />}

      {viewForm && (
        <AssetForm
          me={me}
          initial={viewForm}
          lockSoftware
          readOnly
          onDone={() => setViewForm(null)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === 'detach'
              ? t('software.detachTitle', 'Gỡ khỏi máy?')
              : t('assets.disposeConfirmTitle', 'Thanh lý?')
          }
          message={
            confirm.kind === 'detach'
              ? t('software.detachConfirm', {
                  code: confirm.seat.installedOnCode ?? '',
                  defaultValue:
                    'Gỡ bản này khỏi máy "{{code}}"? Ghế sẽ trống để gán máy khác.',
                })
              : t('assets.disposeConfirmOne', {
                  name: confirm.seat.installedOnCode ?? confirm.seat.licenseName ?? '',
                })
          }
          confirmLabel={
            confirm.kind === 'detach'
              ? t('software.detach', 'Gỡ')
              : t('assets.disposeAction', 'Thanh lý')
          }
          danger
          busy={confirmBusy}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}

      {transferSw && (
        <SoftwareTransferDialog
          me={me}
          softwareId={transferSw.id}
          currentHostCode={transferSw.installedOnCode}
          onDone={(changed) => {
            const name = transferSw.licenseName;
            setTransferSw(null);
            if (changed) {
              void queryClient.invalidateQueries({ queryKey: ['software-groups'] });
              if (name) void reloadSeats(name);
            }
          }}
        />
      )}
    </>
  );
}

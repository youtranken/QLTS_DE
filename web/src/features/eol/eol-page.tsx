import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { downloadFile } from '@/lib/download-file';
import { useConfirm } from '@/ui/confirm-provider';
import { DatePicker } from '@/ui/date-picker';
import { Select } from '@/ui/select';
import { disposeSeat } from '@/features/software/software-seat-ops';
import { formatDmy } from '@/lib/asset-types';
import type { Me } from '@/lib/me';
import '@/features/eol/eol.css';

interface EolMachine {
  id: string;
  code: string | null;
  type: string;
  configuration: string | null;
  startDate: string | null;
  ageYears: number;
  eolDate: string;
  daysToEol: number;
  assignedUserName: string | null;
  eolNotifiedAt: string | null;
}
interface EolSoftware {
  id: string;
  licenseName: string | null;
  installedOnCode: string | null;
  endDate: string | null;
  daysLeft: number;
  assignedUserName: string | null;
}
interface EolData {
  lifespanYears: number;
  warningDays: number;
  machines: EolMachine[];
  software: EolSoftware[];
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function DayPill({ days, overLabel, soonLabel }: { days: number; overLabel: string; soonLabel: string }) {
  const over = days <= 0;
  return (
    <span className={`eol-pill ${over ? 'over' : 'soon'}`}>
      {over ? overLabel.replace('{{n}}', String(Math.abs(days))) : soonLabel.replace('{{n}}', String(days))}
    </span>
  );
}

/**
 * Trang "Cảnh báo EOL" — 2 khối: máy sắp/đã hết hạn (lọc theo số năm đã dùng + khoảng ngày dùng) và
 * license thuê bao sắp/đã hết hạn (lọc theo khoảng ngày hết hạn). Chọn NHIỀU → Thanh lý 1 lần
 * (loop endpoint dispose sẵn có) + Xuất Excel theo bộ lọc. Chỉ cảnh báo; admin tự quyết định.
 */
export function EolPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const askConfirm = useConfirm();
  const [selMachines, setSelMachines] = useState<Set<string>>(new Set());
  const [selSoftware, setSelSoftware] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  // Bộ lọc — máy: tuổi tối thiểu + khoảng ngày bắt đầu dùng; phần mềm: khoảng ngày hết hạn.
  // minYears null = dùng mặc định server (= asset_lifespan_years) → khớp badge sidebar.
  const [minYears, setMinYears] = useState<number | null>(null);
  const [startFrom, setStartFrom] = useState('');
  const [startTo, setStartTo] = useState('');
  const [endFrom, setEndFrom] = useState('');
  const [endTo, setEndTo] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['eol', minYears, startFrom, startTo, endFrom, endTo],
    queryFn: () =>
      apiFetch<EolData>(
        `/api/admin/assets/eol${qs({ minYears: minYears ?? undefined, startFrom, startTo, endFrom, endTo })}`,
      ),
    placeholderData: (prev) => prev,
  });

  const machines = data?.machines ?? [];
  const software = data?.software ?? [];

  // Chỉ thao tác trên dòng ĐANG hiển thị: lọc selection theo danh sách hiện tại (đổi filter → id
  // rớt khỏi bảng KHÔNG bị thanh lý nhầm). Count trên nút cũng theo dòng đang thấy.
  const selMachineIds = useMemo(
    () => machines.filter((m) => selMachines.has(m.id)).map((m) => m.id),
    [machines, selMachines],
  );
  const selSoftwareIds = useMemo(
    () => software.filter((s) => selSoftware.has(s.id)).map((s) => s.id),
    [software, selSoftware],
  );

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (
    set: React.Dispatch<React.SetStateAction<Set<string>>>,
    ids: string[],
    all: boolean,
  ) => set(all ? new Set() : new Set(ids));

  const dispose = useMutation({
    mutationFn: async ({ ids }: { ids: string[]; kind: 'machine' | 'software' }) => {
      const failedIds: string[] = [];
      for (const id of ids) {
        const r = await disposeSeat(id, me.csrfToken);
        if (!r.ok) failedIds.push(id);
      }
      return { total: ids.length, failedIds };
    },
    onSuccess: ({ total, failedIds }, { kind }) => {
      // Giữ LẠI đúng id thất bại (của đúng khối) để admin thấy/thử lại; xóa id đã thanh lý xong.
      const keep = new Set(failedIds);
      if (kind === 'machine') setSelMachines(keep);
      else setSelSoftware(keep);
      void queryClient.invalidateQueries({ queryKey: ['eol'] });
      void queryClient.invalidateQueries({ queryKey: ['nav-count'] });
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      void queryClient.invalidateQueries({ queryKey: ['software-groups'] });
      setErr(failedIds.length > 0 ? t('eol.disposePartial', { failed: failedIds.length, total }) : null);
    },
    onError: () => setErr(t('assets.saveFailed')),
  });

  const runDispose = async (kind: 'machine' | 'software') => {
    const ids = kind === 'machine' ? selMachineIds : selSoftwareIds;
    if (ids.length === 0) return;
    setErr(null);
    const ok = await askConfirm({
      title: t('eol.disposeTitle', 'Thanh lý các mục đã chọn?'),
      message:
        kind === 'machine'
          ? t('eol.disposeMachineMsg', { n: ids.length })
          : t('eol.disposeSoftwareMsg', { n: ids.length }),
      confirmLabel: t('assets.disposeAction', 'Thanh lý'),
      danger: true,
    });
    if (ok) dispose.mutate({ ids, kind });
  };

  const busy = dispose.isPending;

  const allMachinesSel = useMemo(
    () => machines.length > 0 && machines.every((m) => selMachines.has(m.id)),
    [machines, selMachines],
  );
  const allSoftwareSel = useMemo(
    () => software.length > 0 && software.every((s) => selSoftware.has(s.id)),
    [software, selSoftware],
  );
  // Options tuổi gồm cả giá trị lifespan cấu hình (vd 10) để chọn được, khớp badge.
  const yearOptions = useMemo(() => {
    const base = [5, 6, 7, 8];
    const ls = data?.lifespanYears;
    if (ls && !base.includes(ls)) base.push(ls);
    return base.sort((a, b) => a - b);
  }, [data?.lifespanYears]);
  const effMinYears = minYears ?? data?.lifespanYears ?? 8;

  return (
    <section className="eol">
      <div className="page-header">
        <h1 title="End of life">{t('eol.title', 'Cảnh báo EOL')}</h1>
      </div>

      {(isError || err) && <p className="alert error">{err ?? t('assets.loadFailed')}</p>}
      {isLoading && <p className="muted">…</p>}

      {/* KHỐI 1: Máy sắp/đã hết hạn */}
      <div className="eol-block">
        <div className="eol-block-head">
          <h2>
            {t('eol.machinesTitle', 'Máy sắp hết hạn')}{' '}
            <span className="muted">({data?.lifespanYears} {t('eol.years', 'năm')})</span>
          </h2>
          <div className="eol-actions">
            <button
              type="button"
              className="danger"
              disabled={busy || selMachineIds.length === 0}
              onClick={() => void runDispose('machine')}
            >
              {t('eol.disposeSelected', 'Thanh lý đã chọn')} ({selMachineIds.length})
            </button>
            <button
              type="button"
              className="linkbtn"
              onClick={() =>
                downloadFile(
                  `/api/admin/assets/eol/export-machines${qs({ minYears: minYears ?? undefined, startFrom, startTo })}`,
                  'may-eol.xlsx',
                ).catch(() => setErr(t('eol.exportFailed', 'Xuất Excel thất bại.')))
              }
            >
              {t('eol.exportExcel', 'Xuất Excel')}
            </button>
          </div>
        </div>

        <div className="filter-bar">
          <label className="field-inline">
            <span className="muted">{t('eol.filterMinYears', 'Đã dùng từ (năm)')}</span>
            <Select
              ariaLabel={t('eol.filterMinYears', 'Đã dùng từ (năm)')}
              value={String(effMinYears)}
              onChange={(v) => setMinYears(Number(v))}
              options={yearOptions.map((y) => ({
                value: String(y),
                label: t('eol.yearsPlus', { n: y, defaultValue: '{{n}} năm trở lên' }),
              }))}
            />
          </label>
          <label className="field-inline">
            <span className="muted">{t('eol.startFrom', 'Bắt đầu từ')}</span>
            <DatePicker value={startFrom} max={startTo || undefined} ariaLabel={t('eol.startFrom')} onChange={setStartFrom} />
          </label>
          <label className="field-inline">
            <span className="muted">{t('eol.startTo', 'đến')}</span>
            <DatePicker value={startTo} min={startFrom || undefined} ariaLabel={t('eol.startTo')} onChange={setStartTo} />
          </label>
          {(startFrom || startTo) && (
            <button type="button" onClick={() => { setStartFrom(''); setStartTo(''); }}>
              {t('eol.clearFilters', 'Xóa lọc')}
            </button>
          )}
        </div>

        {machines.length === 0 ? (
          <div className="empty">{t('eol.none', 'Không có máy nào khớp bộ lọc.')}</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '2.5rem' }}>
                    <input type="checkbox" aria-label={t('eol.selectAll', 'Chọn tất cả')}
                      checked={allMachinesSel}
                      onChange={() => toggleAll(setSelMachines, machines.map((m) => m.id), allMachinesSel)} />
                  </th>
                  <th>{t('assets.col.code')}</th>
                  <th>{t('assets.col.type', 'Loại')}</th>
                  <th>{t('assets.startDate')}</th>
                  <th>{t('eol.ageYears', 'Đã dùng')}</th>
                  <th>{t('eol.eolDate', 'Ngày hết hạn')}</th>
                  <th>{t('eol.status', 'Tình trạng')}</th>
                  <th>{t('eol.notified', 'Đã báo EOL')}</th>
                  <th>{t('assets.col.user')}</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr key={m.id} className={selMachines.has(m.id) ? 'sel' : ''}>
                    <td>
                      <input type="checkbox" aria-label={m.code ?? m.id}
                        checked={selMachines.has(m.id)} onChange={() => toggle(setSelMachines, m.id)} />
                    </td>
                    <td className="mono">{m.code ?? '—'}</td>
                    <td>{m.type}</td>
                    <td>{m.startDate ? formatDmy(m.startDate) : '—'}</td>
                    <td>{t('eol.yearsUnit', { n: m.ageYears, defaultValue: '{{n}} năm' })}</td>
                    <td>{formatDmy(m.eolDate)}</td>
                    <td>
                      <DayPill days={m.daysToEol}
                        overLabel={t('eol.overYears', 'Quá hạn {{n}} ngày')}
                        soonLabel={t('eol.soonDays', 'Còn {{n}} ngày')} />
                    </td>
                    <td>
                      {m.eolNotifiedAt ? (
                        formatDmy(m.eolNotifiedAt)
                      ) : (
                        <span className="muted">{t('eol.notNotified', 'Chưa báo')}</span>
                      )}
                    </td>
                    <td>{m.assignedUserName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* KHỐI 2: License thuê bao sắp hết hạn */}
      <div className="eol-block">
        <div className="eol-block-head">
          <h2>
            {t('eol.softwareTitle', 'License thuê bao sắp hết hạn')}{' '}
            <span className="muted">(≤{data?.warningDays} {t('eol.days', 'ngày')})</span>
          </h2>
          <div className="eol-actions">
            <button
              type="button"
              className="danger"
              disabled={busy || selSoftwareIds.length === 0}
              onClick={() => void runDispose('software')}
            >
              {t('eol.disposeSelected', 'Thanh lý đã chọn')} ({selSoftwareIds.length})
            </button>
            <button
              type="button"
              className="linkbtn"
              onClick={() =>
                downloadFile(
                  `/api/admin/assets/eol/export-software${qs({ endFrom, endTo })}`,
                  'license-eol.xlsx',
                ).catch(() => setErr(t('eol.exportFailed', 'Xuất Excel thất bại.')))
              }
            >
              {t('eol.exportExcel', 'Xuất Excel')}
            </button>
          </div>
        </div>

        <div className="filter-bar">
          <label className="field-inline">
            <span className="muted">{t('eol.endFrom', 'Hết hạn từ')}</span>
            <DatePicker value={endFrom} max={endTo || undefined} ariaLabel={t('eol.endFrom')} onChange={setEndFrom} />
          </label>
          <label className="field-inline">
            <span className="muted">{t('eol.endTo', 'đến')}</span>
            <DatePicker value={endTo} min={endFrom || undefined} ariaLabel={t('eol.endTo')} onChange={setEndTo} />
          </label>
          {(endFrom || endTo) && (
            <button type="button" onClick={() => { setEndFrom(''); setEndTo(''); }}>
              {t('eol.clearFilters', 'Xóa lọc')}
            </button>
          )}
        </div>

        {software.length === 0 ? (
          <div className="empty">{t('eol.none', 'Không có license nào khớp bộ lọc.')}</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '2.5rem' }}>
                    <input type="checkbox" aria-label={t('eol.selectAll', 'Chọn tất cả')}
                      checked={allSoftwareSel}
                      onChange={() => toggleAll(setSelSoftware, software.map((s) => s.id), allSoftwareSel)} />
                  </th>
                  <th>{t('assets.licenseName')}</th>
                  <th>{t('software.installedOn', 'Trên máy')}</th>
                  <th>{t('assets.endDate')}</th>
                  <th>{t('eol.status', 'Tình trạng')}</th>
                  <th>{t('assets.col.user')}</th>
                </tr>
              </thead>
              <tbody>
                {software.map((s) => (
                  <tr key={s.id} className={selSoftware.has(s.id) ? 'sel' : ''}>
                    <td>
                      <input type="checkbox" aria-label={s.licenseName ?? s.id}
                        checked={selSoftware.has(s.id)} onChange={() => toggle(setSelSoftware, s.id)} />
                    </td>
                    <td>{s.licenseName ?? '—'}</td>
                    <td className="mono">{s.installedOnCode ?? '—'}</td>
                    <td>{s.endDate ? formatDmy(s.endDate) : '—'}</td>
                    <td>
                      <DayPill days={s.daysLeft}
                        overLabel={t('eol.overDays', 'Quá hạn {{n}} ngày')}
                        soonLabel={t('eol.soonDays', 'Còn {{n}} ngày')} />
                    </td>
                    <td>{s.assignedUserName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

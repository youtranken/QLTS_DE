import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Tab = 'asset' | 'user' | 'overdue';

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
interface AssetRow {
  assetId: string;
  code: string;
  type: string;
  count: number;
}
interface UserRow {
  borrowerSub: string;
  fullName: string | null;
  count: number;
}
interface MonthRow {
  month: string;
  total: number;
  overdue: number;
  ratio: number | null;
}

const PAGE_SIZE = 20;

/** YYYY-MM-DD (local) — mốc kỳ mặc định = tháng hiện tại. */
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Báo cáo mượn & quá hạn (6.1) — 3 báo cáo Admin/SA, đọc-thuần, phân trang server-side. */
export function ReportsPage() {
  const { t } = useTranslation();
  const now = new Date();
  const monthStart = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  const today = iso(now);

  const [tab, setTab] = useState<Tab>('asset');
  // Kỳ "draft" (ô nhập) tách khỏi kỳ "applied" (đã bấm Chạy) → gõ ngày KHÔNG tự fetch.
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [applied, setApplied] = useState({ from: monthStart, to: today });
  const [page, setPage] = useState(1);

  const [assets, setAssets] = useState<Paged<AssetRow> | null>(null);
  const [users, setUsers] = useState<Paged<UserRow> | null>(null);
  const [months, setMonths] = useState<MonthRow[] | null>(null);
  const [rangeErr, setRangeErr] = useState(false);
  const [loadErr, setLoadErr] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(false);
    const qs = `from=${applied.from}&to=${applied.to}`;
    try {
      if (tab === 'asset') {
        const r = await fetch(`/api/reports/borrow-by-asset?${qs}&page=${page}&pageSize=${PAGE_SIZE}`);
        if (!r.ok) return setLoadErr(true);
        setAssets((await r.json()) as Paged<AssetRow>);
      } else if (tab === 'user') {
        const r = await fetch(`/api/reports/borrow-by-user?${qs}&page=${page}&pageSize=${PAGE_SIZE}`);
        if (!r.ok) return setLoadErr(true);
        setUsers((await r.json()) as Paged<UserRow>);
      } else {
        const r = await fetch(`/api/reports/overdue-ratio?${qs}`);
        if (!r.ok) return setLoadErr(true);
        setMonths((await r.json()) as MonthRow[]);
      }
    } catch {
      setLoadErr(true);
    }
  }, [tab, applied, page]);

  // Fetch khi đổi tab / trang / kỳ-đã-áp-dụng. Draft from/to KHÔNG nằm trong deps.
  useEffect(() => {
    void load();
  }, [load]);

  const run = () => {
    if (to < from) return setRangeErr(true);
    setRangeErr(false);
    setPage(1);
    setApplied({ from, to });
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setPage(1);
  };

  const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

  return (
    <section>
      <div className="page-header">
        <h1>{t('reports.title')}</h1>
      </div>

      <div className="tabs" style={{ display: 'flex', gap: '.5rem', marginBottom: '1rem' }}>
        <button disabled={tab === 'asset'} onClick={() => switchTab('asset')}>
          {t('reports.tabAsset')}
        </button>
        <button disabled={tab === 'user'} onClick={() => switchTab('user')}>
          {t('reports.tabUser')}
        </button>
        <button disabled={tab === 'overdue'} onClick={() => switchTab('overdue')}>
          {t('reports.tabOverdue')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
        <label>
          {t('reports.from')}
          <br />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t('reports.to')}
          <br />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button onClick={run}>{t('reports.run')}</button>
      </div>

      {rangeErr && <p style={{ color: 'var(--danger)' }}>{t('reports.rangeError')}</p>}

      {loadErr ? (
        <p style={{ color: 'var(--danger)' }}>{t('reports.loadError')}</p>
      ) : (
        <>
          {tab === 'asset' && <AssetTable data={assets} page={page} setPage={setPage} />}
          {tab === 'user' && <UserTable data={users} page={page} setPage={setPage} />}
          {tab === 'overdue' && <MonthTable data={months} pct={pct} />}
        </>
      )}
    </section>
  );
}

function Pager({
  page,
  setPage,
  hasNext,
}: {
  page: number;
  setPage: (n: number) => void;
  hasNext: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ marginTop: '.5rem', display: 'flex', gap: '.5rem', alignItems: 'center' }}>
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
        {t('reports.prev')}
      </button>
      <span>
        {t('reports.page')} {page}
      </span>
      <button disabled={!hasNext} onClick={() => setPage(page + 1)}>
        {t('reports.next')}
      </button>
    </div>
  );
}

function AssetTable({
  data,
  page,
  setPage,
}: {
  data: Paged<AssetRow> | null;
  page: number;
  setPage: (n: number) => void;
}) {
  const { t } = useTranslation();
  if (data === null) return <p className="muted">…</p>;
  if (data.items.length === 0) return <p className="muted">{t('reports.empty')}</p>;
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('reports.colAsset')}</th>
            <th>{t('reports.colType')}</th>
            <th>{t('reports.colCount')}</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((r) => (
            <tr key={r.assetId}>
              <td>{r.code}</td>
              <td>{r.type}</td>
              <td>{r.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} setPage={setPage} hasNext={page * data.pageSize < data.total} />
    </>
  );
}

function UserTable({
  data,
  page,
  setPage,
}: {
  data: Paged<UserRow> | null;
  page: number;
  setPage: (n: number) => void;
}) {
  const { t } = useTranslation();
  if (data === null) return <p className="muted">…</p>;
  if (data.items.length === 0) return <p className="muted">{t('reports.empty')}</p>;
  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('reports.colUser')}</th>
            <th>{t('reports.colCount')}</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((r) => (
            <tr key={r.borrowerSub}>
              <td>{r.fullName ?? r.borrowerSub}</td>
              <td>{r.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} setPage={setPage} hasNext={page * data.pageSize < data.total} />
    </>
  );
}

function MonthTable({
  data,
  pct,
}: {
  data: MonthRow[] | null;
  pct: (r: number | null) => string;
}) {
  const { t } = useTranslation();
  if (data === null) return <p className="muted">…</p>;
  if (data.length === 0) return <p className="muted">{t('reports.empty')}</p>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t('reports.colMonth')}</th>
          <th>{t('reports.colTotal')}</th>
          <th>{t('reports.colOverdue')}</th>
          <th>{t('reports.colRatio')}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r) => (
          <tr key={r.month}>
            <td>{r.month}</td>
            <td>{r.total}</td>
            <td>{r.overdue}</td>
            <td>{pct(r.ratio)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

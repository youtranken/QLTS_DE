import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DatePicker } from './ui/date-picker';

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  objectType: string | null;
  objectId: string | null;
  detail: unknown;
  createdAt: string;
}
interface Paged {
  items: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 20;

interface Filters {
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  from: string;
  to: string;
}
const EMPTY: Filters = {
  actor: '',
  action: '',
  objectType: '',
  objectId: '',
  from: '',
  to: '',
};

/** Viewer audit log (6.2, chỉ SA) — lọc + phân trang server-side; chỉ đọc (AD-10). */
export function AuditLogPage() {
  const { t, i18n } = useTranslation();
  // draft (ô nhập) tách applied (đã bấm Lọc) — gõ KHÔNG tự fetch (mẫu reports 6.1)
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/audit/actions')
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
      .then(setActions)
      .catch(() => setActions([]));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    (Object.keys(applied) as Array<keyof Filters>).forEach((k) => {
      if (applied[k]) params.set(k, applied[k]);
    });
    try {
      const res = await fetch(`/api/admin/audit?${params.toString()}`);
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      const body = (await res.json()) as Paged & { message?: string };
      if (res.ok && Array.isArray(body.items)) {
        setData(body);
      } else {
        setError(body.message ?? t('audit.loadFailed'));
      }
    } catch {
      setError(t('app.serverUnreachable'));
    }
  }, [page, applied, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = () => {
    setApplied(draft);
    setPage(1);
  };
  const set = (k: keyof Filters) => (v: string) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <section>
      <div className="page-header">
        <h1>{t('audit.title')}</h1>
      </div>

      <div className="toolbar" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <input
          placeholder={t('audit.actor')}
          value={draft.actor}
          onChange={(e) => set('actor')(e.target.value)}
        />
        <select
          value={draft.action}
          onChange={(e) => set('action')(e.target.value)}
        >
          <option value="">{t('audit.allActions')}</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          placeholder={t('audit.objectType')}
          value={draft.objectType}
          onChange={(e) => set('objectType')(e.target.value)}
        />
        <input
          placeholder={t('audit.objectId')}
          value={draft.objectId}
          onChange={(e) => set('objectId')(e.target.value)}
        />
        <DatePicker
          value={draft.from}
          onChange={set('from')}
          placeholder={t('audit.from', 'Từ ngày')}
          ariaLabel={t('audit.from', 'Từ ngày')}
        />
        <DatePicker
          value={draft.to}
          onChange={set('to')}
          placeholder={t('audit.to', 'Đến ngày')}
          ariaLabel={t('audit.to', 'Đến ngày')}
        />
        <button type="button" className="primary" onClick={apply}>
          {t('audit.filter')}
        </button>
        {(draft.actor ||
          draft.action ||
          draft.objectType ||
          draft.objectId ||
          draft.from ||
          draft.to) && (
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY);
              setApplied(EMPTY);
              setPage(1);
            }}
          >
            {t('audit.clear')}
          </button>
        )}
      </div>

      {error && <p className="alert error">{error}</p>}

      {data && data.items.length === 0 ? (
        <p className="empty">{t('audit.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('audit.time')}</th>
                <th>{t('audit.actorCol')}</th>
                <th>{t('audit.action')}</th>
                <th>{t('audit.object')}</th>
                <th>{t('audit.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(r.createdAt)}</td>
                  <td>{r.actor}</td>
                  <td>
                    <span className="mono">{r.action}</span>
                  </td>
                  <td>
                    {r.objectType ?? '—'}
                    {r.objectId && (
                      <div className="muted" style={{ fontSize: '0.8rem' }}>
                        <span className="mono">{r.objectId}</span>
                      </div>
                    )}
                  </td>
                  <td>
                    {r.detail != null && (
                      <code style={{ fontSize: '0.78rem', wordBreak: 'break-all' }}>
                        {JSON.stringify(r.detail)}
                      </code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'center',
            marginTop: '0.75rem',
          }}
        >
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ‹ {t('audit.prev')}
          </button>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {t('audit.pageInfo', {
              page: data.page,
              pages: totalPages,
              total: data.total,
            })}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('audit.next')} ›
          </button>
        </div>
      )}
    </section>
  );
}

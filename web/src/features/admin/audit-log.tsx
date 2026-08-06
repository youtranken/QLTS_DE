import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DatePicker } from '@/ui/date-picker';
import { Loading } from '@/ui/load-state';
import '@/features/admin/audit.css';

interface AuditRow {
  id: string;
  actor: string;
  actorName: string | null;
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

/** Mã máy (assets.create) → nhãn người-đọc-hiểu; không có trong từ điển thì tách '.'/'_'. */
const prettify = (s: string) =>
  s.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Viewer audit log (6.2, chỉ SA) — lọc + phân trang server-side; chỉ đọc (AD-10).
 *  Hiển thị người-đọc-hiểu: người (tên), hành động + đối tượng (dịch), chi tiết (cặp khoá:giá trị). */
export function AuditLogPage() {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged | null>(null);
  const [loading, setLoading] = useState(true);
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
    setLoading(true);
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
    } finally {
      setLoading(false);
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
  const hasFilter = Object.values(draft).some(Boolean);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language === 'vi' ? 'vi-VN' : 'en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  // Người: tên thật; system/SA → nhãn; còn lại (sub lạ) → hiện sub.
  const actorLabel = (r: AuditRow) =>
    r.actorName ??
    (r.actor === 'system'
      ? t('audit.actorSystem', 'Hệ thống')
      : r.actor.startsWith('local:')
        ? t('audit.actorSa', 'SA (nội bộ)')
        : r.actor);
  const actionLabel = (a: string) =>
    t(`auditAction.${a}`, { defaultValue: prettify(a) });
  const objectLabel = (ty: string | null) =>
    ty ? t(`auditObject.${ty}`, { defaultValue: prettify(ty) }) : '—';

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <section>
      <div className="page-header">
        <h1>{t('audit.title')}</h1>
      </div>

      {/* Filter GỌN trên MỘT hàng (wrap khi hẹp). */}
      <div className="audit-filters">
        <input
          className="af-actor"
          aria-label={t('audit.actor')}
          placeholder={t('audit.actor')}
          value={draft.actor}
          onChange={(e) => set('actor')(e.target.value)}
        />
        <select
          aria-label={t('audit.allActions')}
          value={draft.action}
          onChange={(e) => set('action')(e.target.value)}
        >
          <option value="">{t('audit.allActions')}</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
        <input
          className="af-obj"
          aria-label={t('audit.objectType')}
          placeholder={t('audit.objectType')}
          value={draft.objectType}
          onChange={(e) => set('objectType')(e.target.value)}
        />
        <input
          className="af-obj"
          aria-label={t('audit.objectId')}
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
        {hasFilter && (
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

      {error && <p role="alert" className="alert error">{error}</p>}

      {loading && !data ? (
        <Loading />
      ) : data && data.items.length === 0 ? (
        <p className="empty">{t('audit.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table audit-table">
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
                  <td title={r.actor}>{actorLabel(r)}</td>
                  <td>{actionLabel(r.action)}</td>
                  <td>
                    {objectLabel(r.objectType)}
                    {r.objectId && (
                      <div
                        className="muted audit-objid"
                        title={r.objectId}
                      >
                        {r.objectId}
                      </div>
                    )}
                  </td>
                  <td>
                    <AuditDetail detail={r.detail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <div className="audit-pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ‹ {t('audit.prev')}
          </button>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {t('audit.pageInfo', { page: data.page, pages: totalPages, total: data.total })}
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

/** Chi tiết dạng cặp "khoá: giá trị" đọc-hiểu-được thay cho JSON thô. */
function AuditDetail({ detail }: { detail: unknown }) {
  const { t } = useTranslation();
  if (detail == null) return <span className="muted">—</span>;
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    return <span>{String(detail)}</span>;
  }
  const entries = Object.entries(detail as Record<string, unknown>).filter(
    ([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0),
  );
  if (entries.length === 0) return <span className="muted">—</span>;
  const fmtVal = (v: unknown): string => {
    if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
    if (typeof v === 'boolean') return v ? t('common.yes', 'Có') : t('common.no', 'Không');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  return (
    <div className="audit-detail">
      {entries.map(([k, v]) => (
        <span key={k} className="audit-kv">
          <b>{t(`auditDetail.${k}`, { defaultValue: prettify(k) })}:</b> {fmtVal(v)}
        </span>
      ))}
    </div>
  );
}

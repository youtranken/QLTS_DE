import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

interface QueueCard {
  key: string;
  count: number | null;
  to: string;
  danger?: boolean;
}

/**
 * Dashboard tác vụ Admin (3.12, FR-45) — landing của admin/sa. 5 hàng đợi kèm số đếm,
 * dẫn thẳng đến workspace thao tác (≤2 click). Cấu trúc mở: Epic 4/5 thêm card không sửa lõi.
 */
export function AdminDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Record<string, number | null>>({
    pending: null,
    pickup: null,
    inuse: null,
    overdue: null,
    locked: null,
  });

  useEffect(() => {
    let alive = true;
    const arrLen = (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<unknown[]>) : []))
        .then((d) => (Array.isArray(d) ? d.length : 0))
        .catch(() => 0);
    const totalOf = (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<{ total: number }>) : { total: 0 }))
        .then((d) => d.total ?? 0)
        .catch(() => 0);
    void Promise.all([
      arrLen('/api/admin/tickets/pending-approval'),
      arrLen('/api/admin/tickets/awaiting-pickup'),
      arrLen('/api/admin/tickets/in-use'),
      arrLen('/api/admin/tickets/overdue'),
      totalOf('/api/admin/assets?status=locked_repair&pageSize=1'),
    ]).then(([pending, pickup, inuse, overdue, locked]) => {
      if (alive) setCounts({ pending, pickup, inuse, overdue, locked });
    });
    return () => {
      alive = false;
    };
  }, []);

  const cards: QueueCard[] = [
    { key: 'pending', count: counts.pending, to: '/xu-ly-muon' },
    { key: 'pickup', count: counts.pickup, to: '/xu-ly-muon' },
    { key: 'inuse', count: counts.inuse, to: '/xu-ly-muon' },
    { key: 'overdue', count: counts.overdue, to: '/xu-ly-muon', danger: true },
    { key: 'locked', count: counts.locked, to: '/tai-san?status=locked_repair' },
    // Epic 4 "chờ gia hạn" + Epic 5 "cảnh báo nghỉ việc" thêm card ở đây — cấu trúc mở (AC2).
  ];

  return (
    <section>
      <h1 style={{ fontSize: '1.3rem', marginBottom: '1rem' }}>
        {t('dashboard.title')}
      </h1>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '1rem',
        }}
      >
        {cards.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => navigate(c.to)}
            style={{
              textAlign: 'left',
              padding: '1rem',
              border: `1px solid ${c.danger && (c.count ?? 0) > 0 ? '#c0392b' : '#ddd'}`,
              borderRadius: 8,
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                fontSize: '2rem',
                fontWeight: 700,
                color: c.danger && (c.count ?? 0) > 0 ? '#c0392b' : '#1a1a2e',
              }}
            >
              {c.count ?? '…'}
            </div>
            <div style={{ color: '#555' }}>{t(`dashboard.${c.key}`)}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

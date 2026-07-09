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
    extension: null,
    pickup: null,
    inuse: null,
    overdue: null,
    locked: null,
    notifyFailed: null,
    offboard: null,
    expiring: null,
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
    const countOf = (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<{ count: number }>) : { count: 0 }))
        .then((d) => d.count ?? 0)
        .catch(() => 0);
    void Promise.all([
      arrLen('/api/admin/tickets/pending-approval'),
      arrLen('/api/admin/tickets/extensions'),
      arrLen('/api/admin/tickets/awaiting-pickup'),
      arrLen('/api/admin/tickets/in-use'),
      arrLen('/api/admin/tickets/overdue'),
      totalOf('/api/admin/assets?status=locked_repair&pageSize=1'),
      totalOf('/api/admin/notifications/failed'),
      totalOf('/api/admin/offboarding'),
      countOf('/api/admin/assets/expiring-count'),
    ]).then(
      ([
        pending,
        extension,
        pickup,
        inuse,
        overdue,
        locked,
        notifyFailed,
        offboard,
        expiring,
      ]) => {
        if (alive)
          setCounts({
            pending,
            extension,
            pickup,
            inuse,
            overdue,
            locked,
            notifyFailed,
            offboard,
            expiring,
          });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const cards: QueueCard[] = [
    { key: 'pending', count: counts.pending, to: '/xu-ly-muon' },
    { key: 'extension', count: counts.extension, to: '/xu-ly-muon' },
    { key: 'pickup', count: counts.pickup, to: '/xu-ly-muon' },
    { key: 'inuse', count: counts.inuse, to: '/xu-ly-muon' },
    { key: 'overdue', count: counts.overdue, to: '/xu-ly-muon', danger: true },
    { key: 'locked', count: counts.locked, to: '/tai-san?status=locked_repair' },
    // 7.7: sắp hết hạn (gộp thiết bị + license) — nổi đỏ khi >0, dẫn tới danh sách đã lọc
    {
      key: 'expiring',
      count: counts.expiring,
      to: '/tai-san?expiring=true',
      danger: true,
    },
    // Ẩn khi count=0 (không hiện mục rỗng chưa build — 3.12 AC2); nổi đỏ khi có lỗi gửi (5.1).
    ...(counts.notifyFailed && counts.notifyFailed > 0
      ? [
          {
            key: 'notifyFailed',
            count: counts.notifyFailed,
            to: '/thong-bao-loi',
            danger: true,
          } as QueueCard,
        ]
      : []),
    // Cảnh báo nghỉ việc (5.5) — ẩn khi 0, nổi đỏ khi có user disable còn tài sản/ticket.
    ...(counts.offboard && counts.offboard > 0
      ? [
          {
            key: 'offboard',
            count: counts.offboard,
            to: '/canh-bao-nghi-viec',
            danger: true,
          } as QueueCard,
        ]
      : []),
  ];

  return (
    <section>
      <div className="page-header">
        <h1>{t('dashboard.title')}</h1>
      </div>
      <div className="stat-grid">
        {cards.map((c) => {
          const isDanger = c.danger && (c.count ?? 0) > 0;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => navigate(c.to)}
              className={isDanger ? 'stat-card critical' : 'stat-card'}
            >
              <div className={`stat-num${c.count === 0 ? ' zero' : ''}`}>
                {c.count ?? '…'}
              </div>
              <div className="stat-label">{t(`dashboard.${c.key}`)}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { AssetForm } from './asset-form';
import { AssetSoftwareTable } from './asset-software-list';
import type { InstalledSoftware } from './asset-software-list';
import { detailToForm, STATUS_BADGE } from './asset-types';
import type { AllocationRow, AssetDetail, NoteRow } from './asset-types';
import type { Me } from './panels';
import { PhotoLightbox } from './photo-lightbox';
import type { LightboxImage } from './photo-lightbox';

/** Trang chi tiết máy 3 tab (story 2.7, UJ-3) — route /tai-san/:id. */
export function AssetDetailPage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'alloc' | 'loan' | 'notes'>('alloc');
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [handovers, setHandovers] = useState<
    Array<{
      ticketId: string;
      stateLabel: string;
      borrowerName: string | null;
      from: string;
      to: string;
      deliveredAt: string | null;
      returnedAt: string | null;
      photoCount: number;
    }>
  >([]);
  const [handoverTotal, setHandoverTotal] = useState(0);
  const [handoverPage, setHandoverPage] = useState(1);
  const HANDOVER_PAGE_SIZE = 20;
  const [software, setSoftware] = useState<InstalledSoftware[]>([]);
  const [error, setError] = useState<string | null>(null);
  // UP-5.5: lightbox ảnh biên bản — mở khi bấm "Xem ảnh" ở một lượt bàn giao (lazy fetch).
  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);

  const openPhotos = useCallback(
    async (ticketId: string) => {
      setPhotoBusy(ticketId);
      try {
        const res = await fetch(
          `/api/booking/tickets/${encodeURIComponent(ticketId)}/photos`,
        );
        if (!res.ok) return;
        const list = (await res.json()) as Array<{
          fileId: string;
          phase: string;
        }>;
        setLightbox(
          list.map((p) => ({
            url: `/api/booking/tickets/${encodeURIComponent(ticketId)}/photos/${encodeURIComponent(p.fileId)}`,
            label: t(`assets.hoPhase.${p.phase}`, p.phase),
          })),
        );
      } finally {
        setPhotoBusy(null);
      }
    },
    [t],
  );

  const loadAll = useCallback(async () => {
    if (!id) return;
    setError(null);
    setNotFound(false); // id đổi qua history không remount — không kẹt notFound cũ
    try {
      const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      if (res.status === 404 || res.status === 400) {
        // 400 = id không phải uuid (deep-link gõ tay) — cùng một thông báo
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        setError(t('assets.loadFailed'));
        return;
      }
      const a = (await res.json()) as AssetDetail;
      setDetail(a);
      const [allocRes, noteRes, swRes, hoRes] = await Promise.all([
        fetch(`/api/admin/assets/${encodeURIComponent(id)}/allocations`),
        fetch(`/api/admin/assets/${encodeURIComponent(id)}/notes`),
        a.type !== 'software'
          ? fetch(`/api/admin/assets/${encodeURIComponent(id)}/software`)
          : Promise.resolve(null),
        a.type !== 'software'
          ? fetch(`/api/admin/tickets/by-asset/${encodeURIComponent(id)}/handovers`)
          : Promise.resolve(null),
      ]);
      // fetch phụ lỗi phải HIỆN lỗi — "chưa có dữ liệu" khác "không tải được" (UJ-3)
      if (allocRes.ok) {
        setAllocations((await allocRes.json()) as AllocationRow[]);
      } else {
        setError(t('assets.loadFailed'));
      }
      if (noteRes.ok) {
        setNotes((await noteRes.json()) as NoteRow[]);
      } else {
        setError(t('assets.loadFailed'));
      }
      if (swRes) {
        if (swRes.ok) {
          setSoftware((await swRes.json()) as typeof software);
        } else {
          setError(t('assets.loadFailed'));
        }
      }
      if (hoRes) {
        if (hoRes.ok) {
          const body = (await hoRes.json()) as {
            items: typeof handovers;
            total: number;
          };
          setHandovers(body.items);
          setHandoverTotal(body.total);
        } else {
          setError(t('assets.loadFailed'));
        }
      }
    } catch {
      setError(t('app.serverUnreachable'));
    }
  }, [id, t]);

  const loadHandovers = useCallback(
    async (page: number) => {
      if (!id) return;
      const res = await fetch(
        `/api/admin/tickets/by-asset/${encodeURIComponent(id)}/handovers?page=${page}`,
      );
      if (res.ok) {
        const body = (await res.json()) as {
          items: typeof handovers;
          total: number;
        };
        setHandovers(body.items);
        setHandoverTotal(body.total);
        setHandoverPage(page);
      }
    },
    [id],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const fmtDateTime = (v: string) =>
    new Date(v).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN');

  if (notFound) {
    return (
      <>
        <p>{t('assets.notFound')}</p>
        <Link to="/tai-san">{t('assets.backToList')}</Link>
      </>
    );
  }
  if (!detail) {
    return <p>{error ?? t('app.checkingSession')}</p>;
  }

  const info: Array<[string, React.ReactNode]> = [
    // Mã đã hiện ở tiêu đề (h1) → không lặp lại trong lưới thông tin.
    [
      t('assets.type'),
      detail.type === 'software' ? t('assets.kindSoftware') : detail.type,
    ],
    [t('assets.statusLabel'), t(`assets.status.${detail.status}`)],
    [t('assets.configuration'), detail.configuration],
    [
      t('assets.cost'),
      detail.cost == null
        ? null
        : detail.cost.toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN'),
    ],
    [t('assets.startDate'), detail.startDate],
    [t('assets.endDate'), detail.endDate],
    [t('assets.serial'), detail.serial],
    [t('assets.brand'), detail.brand],
    // User + Pool bỏ khỏi lưới thông tin — đã có ở panel "Người giữ hiện tại" (tránh trùng).
    [t('assets.note'), detail.note],
  ];
  if (detail.type === 'software') {
    info.push(
      [
        t('assets.licenseType'),
        detail.licenseType === 'term'
          ? t('assets.licenseTerm')
          : detail.licenseType === 'perpetual'
            ? t('assets.licensePerpetual')
            : null,
      ],
      [t('assets.licenseName'), detail.licenseName],
      [
        t('assets.installedOn'),
        detail.installedOnAssetId
          ? (detail.installedOnCode ?? detail.installedOnAssetId)
          : t('assets.installedNone'),
      ],
    );
  }

  // Bảo hành/hạn dùng: % đã trôi + số ngày còn lại (chỉ khi có đủ start+end). endDate = hạn.
  const warranty = (() => {
    if (detail.type === 'software' || !detail.startDate || !detail.endDate) {
      return null;
    }
    const start = new Date(detail.startDate).getTime();
    const end = new Date(detail.endDate).getTime();
    const now = Date.now();
    if (!(end > start)) return null;
    const pct = Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
    const daysLeft = Math.ceil((end - now) / 86400000);
    const tone = daysLeft < 0 ? 'danger' : daysLeft <= 30 ? 'warn' : 'ok';
    return { pct, daysLeft, tone };
  })();

  return (
    <>
      <p style={{ marginBottom: '0.5rem' }}>
        <Link to="/tai-san">‹ {t('assets.backToList')}</Link>
      </p>
      <div className="page-header">
        <h1>{detail.code ?? detail.licenseName ?? '—'}</h1>
        <span className={`badge ${STATUS_BADGE[detail.status] ?? 'muted'}`}>
          {t(`assets.status.${detail.status}`)}
        </span>
        {detail.type !== 'software' && (
          <Link className="linkbtn" to={`/lich-may/${id}`}>
            {t('calendar.openLink', 'Lịch máy')}
          </Link>
        )}
        <button type="button" className="primary" onClick={() => setEditing(true)}>
          {t('assets.edit')}
        </button>
      </div>
      {error && <p className="alert error">{error}</p>}
      <div className="card" style={{ padding: '1.25rem', margin: '0.5rem 0 1rem' }}>
        <dl className="data-grid">
          {info
            .filter(([, v]) => v != null && v !== '')
            .map(([label, value]) => (
              <div className="data-item" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      </div>
      {detail.type !== 'software' && (
        <div className="detail-cards">
          <div className="card mini-card">
            <div className="mc-label">{t('assets.currentHolder', 'Người giữ hiện tại')}</div>
            {detail.assignedUserSub ? (
              <div className="mc-value">
                {detail.assignedUserName ?? detail.assignedUserSub}
              </div>
            ) : (
              <div className="mc-value muted">{t('assets.assigneeEmpty')}</div>
            )}
            {detail.isPool && (
              <span className="badge ok" style={{ marginTop: '0.5rem' }}>
                {t('assets.pool')}
              </span>
            )}
          </div>
          <div className="card mini-card">
            <div className="mc-label">{t('assets.warranty', 'Bảo hành / hạn dùng')}</div>
            {warranty ? (
              <>
                <div className="warranty-bar">
                  <div
                    className={`warranty-fill ${warranty.tone}`}
                    style={{ width: `${warranty.pct}%` }}
                  />
                </div>
                <div className="warranty-meta">
                  <span className="muted">
                    {detail.startDate} → {detail.endDate}
                  </span>
                  <span className={`badge ${warranty.tone}`}>
                    {warranty.daysLeft < 0
                      ? t('assets.warrantyExpired', 'Đã hết hạn')
                      : t('assets.warrantyDaysLeft', 'Còn {{d}} ngày', {
                          d: warranty.daysLeft,
                        })}
                  </span>
                </div>
              </>
            ) : (
              <div className="mc-value muted">
                {t('assets.warrantyNone', 'Chưa có mốc bảo hành')}
              </div>
            )}
          </div>
        </div>
      )}
      {detail.type !== 'software' && (
        <div style={{ margin: '0.75rem 0 1.25rem' }}>
          <h3 style={{ margin: '0 0 0.4rem' }}>{t('assets.installedSoftware')}</h3>
          <AssetSoftwareTable items={software} />
        </div>
      )}
      {/* Phần mềm đi theo máy → không có lịch sử cấp phát / mượn-trả / note tình trạng riêng
          (người ta chỉ mượn máy). Ẩn toàn bộ tab cho phần mềm — chi tiết ở thẻ trên là đủ. */}
      {detail.type !== 'software' && (
        <>
      <div className="tabs">
        <button
          type="button"
          className={tab === 'alloc' ? 'tab active' : 'tab'}
          onClick={() => setTab('alloc')}
        >
          {t('assets.allocationHistory')}
        </button>
        <button
          type="button"
          className={tab === 'loan' ? 'tab active' : 'tab'}
          onClick={() => setTab('loan')}
        >
          {t('assets.loanTab')}
        </button>
        <button
          type="button"
          className={tab === 'notes' ? 'tab active' : 'tab'}
          onClick={() => setTab('notes')}
        >
          {t('assets.notesTab')}
        </button>
      </div>
      <div className="detail-tabs-body" style={{ marginTop: '0.75rem' }}>
        {tab === 'alloc' &&
          (allocations.length === 0 ? (
            <p className="empty">{t('assets.noAllocations')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('assets.allocDate')}</th>
                    <th>{t('assets.allocFrom')}</th>
                    <th>{t('assets.allocTo')}</th>
                    <th>{t('assets.allocActor')}</th>
                    <th>{t('assets.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((h) => (
                    <tr key={h.id}>
                      <td>{fmtDateTime(h.createdAt)}</td>
                      <td>
                        {h.fromUserSub
                          ? (h.fromUserName ?? h.fromUserSub)
                          : t('assets.stock')}
                      </td>
                      <td>
                        {h.toUserSub
                          ? (h.toUserName ?? h.toUserSub)
                          : t('assets.stock')}
                      </td>
                      <td>{h.actorName ?? h.actor}</td>
                      <td>{h.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'loan' &&
          (handovers.length === 0 ? (
            <p className="empty">{t('assets.loanTabEmpty')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('assets.hoBorrower')}</th>
                    <th>{t('assets.hoWindow')}</th>
                    <th>{t('assets.hoDelivered')}</th>
                    <th>{t('assets.hoReturned')}</th>
                    <th>{t('assets.hoState')}</th>
                    <th>{t('assets.hoPhotos')}</th>
                  </tr>
                </thead>
                <tbody>
                  {handovers.map((h) => (
                    <tr key={h.ticketId}>
                      <td>{h.borrowerName ?? '—'}</td>
                      <td>
                        {fmtDateTime(h.from)} → {fmtDateTime(h.to)}
                      </td>
                      <td>{h.deliveredAt ? fmtDateTime(h.deliveredAt) : '—'}</td>
                      <td>{h.returnedAt ? fmtDateTime(h.returnedAt) : '—'}</td>
                      <td>
                        <span className="badge muted">{h.stateLabel}</span>
                      </td>
                      <td>
                        {h.photoCount > 0 ? (
                          <button
                            type="button"
                            className="ghost sm"
                            disabled={photoBusy === h.ticketId}
                            onClick={() => void openPhotos(h.ticketId)}
                          >
                            {t('assets.hoViewPhotos', { count: h.photoCount })}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'loan' && handoverTotal > HANDOVER_PAGE_SIZE && (
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: 8 }}>
            <button
              type="button"
              disabled={handoverPage <= 1}
              onClick={() => void loadHandovers(handoverPage - 1)}
            >
              ‹ {t('assets.prev')}
            </button>
            <span>
              {handoverPage} / {Math.ceil(handoverTotal / HANDOVER_PAGE_SIZE)}
            </span>
            <button
              type="button"
              disabled={handoverPage >= Math.ceil(handoverTotal / HANDOVER_PAGE_SIZE)}
              onClick={() => void loadHandovers(handoverPage + 1)}
            >
              {t('assets.next')} ›
            </button>
          </div>
        )}
        {tab === 'notes' &&
          (notes.length === 0 ? (
            <p className="empty">{t('assets.noNotes')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('assets.allocDate')}</th>
                    <th>{t('assets.noteKind')}</th>
                    <th>{t('assets.note')}</th>
                    <th>{t('assets.lockEta')}</th>
                    <th>{t('assets.allocActor')}</th>
                  </tr>
                </thead>
                <tbody>
                  {notes.map((n) => (
                    <tr key={n.id}>
                      <td>{fmtDateTime(n.createdAt)}</td>
                      <td>{t(`assets.noteKinds.${n.kind}`)}</td>
                      <td>{n.note}</td>
                      <td>{n.eta}</td>
                      <td>{n.actorName ?? n.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>
        </>
      )}

      {editing && (
        <AssetForm
          me={me}
          initial={detailToForm(detail)}
          onDone={() => {
            setEditing(false);
            void loadAll(); // defer 2.3: chi tiết luôn refetch sau khi đóng form
          }}
        />
      )}

      {lightbox && (
        <PhotoLightbox images={lightbox} onClose={() => setLightbox(null)} />
      )}
    </>
  );
}

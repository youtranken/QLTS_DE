import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { MyRequestsPanel } from '@/features/tickets/my-requests';
import { RecurringBuilder } from '@/features/booking/recurring-builder';
import type { Me } from '@/lib/me';

const MAX_DURATION_AUTO_MS = 48 * 60 * 60 * 1000;

interface AvailableSoftware {
  id: string;
  code: string;
  licenseName: string | null;
  licenseType: string | null;
}
interface AvailableMachine {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
  brand: string | null;
  model: string | null;
  floor: string | null;
  software: AvailableSoftware[];
}

/**
 * Landing đặt máy (3.1b): chọn khung giờ → xem máy pool rảnh kèm cấu hình + software.
 * datetime-local trả giờ LOCAL không offset; new Date(...).toISOString() quy về UTC 'Z'
 * — giữ đúng INSTANT, server nhận offset hợp lệ (party phiên 7 chống lệch giờ).
 * Nút "Chọn" (submit đặt) là story 3.1c.
 */
export function BookingPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [machines, setMachines] = useState<AvailableMachine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  // Khung giờ đã dùng để tìm danh sách đang hiển thị — đổi input mà chưa tìm lại
  // thì "Chọn" bị khóa (không đặt khung B trên máy chỉ xác nhận rảnh ở khung A).
  const [searchedKey, setSearchedKey] = useState<string | null>(null);
  const [myReqReload, setMyReqReload] = useState(0);
  const currentKey = from && to ? `${from}|${to}` : null;
  const rangeStale = searchedKey !== null && searchedKey !== currentKey;

  // Form-gate >48h (AC 4): duration tính từ input; chặn nếu không có quyền dài hạn.
  const durationMs =
    from && to ? new Date(to).getTime() - new Date(from).getTime() : 0;
  const isLongTerm = durationMs > MAX_DURATION_AUTO_MS;
  const canLongTerm = me.permissions?.canLongTerm ?? false;
  const longTermBlocked = isLongTerm && !canLongTerm;

  const search = useCallback(async () => {
    setError(null);
    setNotice(null);
    if (!from || !to) return;
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    setLoading(true);
    try {
      const res = await fetch(
        `/api/booking/availability?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      );
      if (res.ok) {
        setMachines((await res.json()) as AvailableMachine[]);
        setSearchedKey(`${from}|${to}`);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      const map: Record<string, string> = {
        INVALID_RANGE: t('booking.errInvalidRange'),
        PAST_PICKUP: t('booking.errPast'),
        BOOKING_WINDOW: t('booking.errWindow'),
      };
      setError((body.code && map[body.code]) || t('booking.errGeneric'));
      setMachines(null);
    } catch {
      setError(t('booking.errGeneric'));
      setMachines(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, t]);

  const submit = useCallback(
    async (assetId: string) => {
      setError(null);
      setNotice(null);
      setSubmitting(assetId);
      try {
        const res = await fetch('/api/booking', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({
            assetId,
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
          }),
        });
        if (res.status === 201 || res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            autoApproved?: boolean;
          };
          setNotice(
            body.autoApproved
              ? t('booking.submitOkAuto')
              : t('booking.submitOkHeld'),
          );
          setMyReqReload((n) => n + 1); // "Request của tôi" cập nhật ngay
          await search(); // refetch — khung vừa đặt biến khỏi danh sách
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        const map: Record<string, string> = {
          SLOT_TAKEN: t('booking.errSlotTaken'),
          ASSET_UNAVAILABLE: t('booking.errAssetUnavailable'),
          QUOTA_EXCEEDED: t('booking.errQuota'),
          LONG_TERM_REQUIRED: t('booking.errLongTerm'),
        };
        setError((body.code && map[body.code]) || t('booking.errGeneric'));
        // 409 chồng giờ/khóa máy → refetch trước khi cho đặt lại (conventions)
        if (body.code === 'SLOT_TAKEN' || body.code === 'ASSET_UNAVAILABLE') {
          await search();
        }
      } catch {
        setError(t('booking.errGeneric'));
      } finally {
        setSubmitting(null);
      }
    },
    [from, to, me.csrfToken, search, t],
  );

  return (
    <section>
      <div className="page-header">
        <h1>{t('booking.title')}</h1>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        className="filter-bar"
        style={{ alignItems: 'flex-end', gap: '0.85rem' }}
      >
        <label className="field">
          <span>{t('booking.from')}</span>
          <input
            type="datetime-local"
            value={from}
            required
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('booking.to')}</span>
          <input
            type="datetime-local"
            value={to}
            required
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="primary"
          disabled={loading || !from || !to}
        >
          {loading ? t('booking.searching') : t('booking.search')}
        </button>
      </form>

      {longTermBlocked && (
        <p className="alert warn">{t('booking.errLongTerm')}</p>
      )}
      {error && <p className="alert error">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {machines === null && !error && (
        <p className="empty">{t('booking.prompt')}</p>
      )}
      {machines !== null && machines.length === 0 && (
        <p className="empty">{t('booking.empty')}</p>
      )}
      {machines !== null && machines.length > 0 && (
        <>
          <p className="muted" style={{ marginBottom: '0.6rem' }}>
            {t('booking.resultCount', { n: machines.length })}
            {rangeStale && (
              <span style={{ color: 'var(--warn)' }}>
                {' '}
                — {t('booking.staleRange')}
              </span>
            )}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {[
                    'colCode',
                    'colType',
                    'colConfig',
                    'colFloor',
                    'colSoftware',
                  ].map((k) => (
                    <th key={k}>{t(`booking.${k}`)}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <span className="mono">{m.code}</span>
                    </td>
                    <td>{m.type}</td>
                    <td>{m.configuration ?? '—'}</td>
                    <td>{m.floor ?? '—'}</td>
                    <td>
                      {m.software.length === 0 ? (
                        <span className="muted">{t('booking.noSoftware')}</span>
                      ) : (
                        m.software.map((s) => s.licenseName || s.code).join(', ')
                      )}
                    </td>
                    <td className="table-actions">
                      <button
                        type="button"
                        className="primary sm"
                        disabled={
                          longTermBlocked || submitting !== null || rangeStale
                        }
                        title={rangeStale ? t('booking.staleRange') : undefined}
                        onClick={() => void submit(m.id)}
                      >
                        {submitting === m.id
                          ? t('booking.submitting')
                          : t('booking.pick')}
                      </button>{' '}
                      <button
                        type="button"
                        className="sm"
                        onClick={() => navigate(`/calendar/${m.id}`)}
                      >
                        {t('booking.viewCalendar')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {me.permissions?.canRecurring && (
        <RecurringBuilder
          me={me}
          onDone={() => setMyReqReload((n) => n + 1)}
        />
      )}
      <InUseNowPanel />
      <MyRequestsPanel me={me} reloadKey={myReqReload} />
    </section>
  );
}

interface InUseRow {
  borrowerName: string | null;
  assetCode: string | null;
  from: string | null;
  to: string | null;
}

/**
 * "Máy đang được mượn" (3.11, NFR-2) — snapshot ai đang giữ máy gì; không lộ sub/email.
 * `standalone`: mục sidebar riêng → có page-header + empty-state; mặc định = panel dưới
 * trang đặt máy (ẩn khi rỗng).
 */
export function InUseNowPanel({ standalone = false }: { standalone?: boolean }) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<InUseRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/booking/in-use-now')
      .then((r) => (r.ok ? (r.json() as Promise<InUseRow[]>) : []))
      .then((d) => alive && setRows(d))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, []);

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(
          i18n.language === 'vi' ? 'vi-VN' : 'en-US',
          {
            timeZone: 'Asia/Ho_Chi_Minh',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          },
        )
      : '—';

  // Panel dưới trang đặt máy: ẩn khi rỗng. Trang riêng: luôn hiện + empty-state.
  if (!standalone && (rows === null || rows.length === 0)) return null;
  return (
    <section className={standalone ? undefined : 'section-gap'}>
      {standalone ? (
        <div className="page-header">
          <h1>{t('inusenow.title')}</h1>
        </div>
      ) : (
        <h2 style={{ marginBottom: '0.75rem' }}>{t('inusenow.title')}</h2>
      )}
      {rows !== null && (rows.length > 0 || standalone) && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['colBorrower', 'colMachine', 'colTime'].map((k) => (
                  <th key={k}>{t(`inusenow.${k}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    {t('inusenow.empty')}
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.borrowerName ?? '—'}</td>
                  <td>
                    <span className="mono">{r.assetCode ?? '—'}</span>
                  </td>
                  <td>
                    {fmt(r.from)} → {fmt(r.to)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

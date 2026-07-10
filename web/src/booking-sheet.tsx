import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import { RecurringBuilder } from './recurring-builder';
import type { Me } from './panels';

const MAX_DURATION_AUTO_MS = 48 * 60 * 60 * 1000;
// Khung giờ làm việc (9.8): chỉ cho đặt 07:00–18:00, T2–T7 (CN khóa). Giờ VN (UTC+7 cố định).
const WORK_START = '07:00';
const WORK_END = '18:00';
// #3: khung giờ nhận nhanh (chip) trong giờ làm việc.
const PICKUP_SLOTS = ['08:00', '09:00', '10:00', '13:30', '14:00', '15:00', '16:00'];
/** Ngày local (YYYY-MM-DD) theo tz máy — dùng cho default + min của input date. */
const todayLocal = (): string => new Date().toLocaleDateString('en-CA');
/** HH:MM local hiện tại — chặn chọn giờ đã qua trong hôm nay. */
const nowTimeLocal = (): string =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** true nếu chuỗi YYYY-MM-DD rơi vào Chủ nhật (local). */
const isSunday = (d: string): boolean =>
  d ? new Date(`${d}T00:00`).getDay() === 0 : false;

interface FreeMachine {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
}
interface UserOption {
  sub: string;
  fullName: string | null;
  email: string | null;
}
type Mode = 'normal' | 'advanced' | 'recurring';

/**
 * Popup Đặt máy (7.5) — loại mượn gate theo quyền (Thường/Nâng cao/Định kỳ); admin tạo hộ.
 * Thường/Nâng cao dùng chung form (khác nhau ở >2 ngày); Định kỳ: member reuse RecurringBuilder,
 * admin builder buổi → recurring-for. Đóng: ✕ / Hủy / Esc.
 */
export function BookingSheet({
  me,
  onClose,
  onBooked,
  presetAssetId,
}: {
  me: Me;
  onClose: () => void;
  onBooked: () => void;
  /** 9.5: mở từ bảng "Máy có thể mượn" → tự chọn đúng máy khi nó xuất hiện trong danh sách rảnh. */
  presetAssetId?: string;
}) {
  const { t } = useTranslation();
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  const canLong = isAdmin || (me.permissions?.canLongTerm ?? false);
  const canRecur = isAdmin || (me.permissions?.canRecurring ?? false);

  const [mode, setMode] = useState<Mode>('normal');
  const [note, setNote] = useState('');
  // Admin tạo hộ: người mượn
  const [borrower, setBorrower] = useState<UserOption | null>(null);
  const [userQuery, setUserQuery] = useState('');
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  // Thường/Nâng cao — tách Ngày + Giờ cho Nhận/Trả (4 ô), gộp lại thành datetime khi dùng.
  // Ngày mặc định = hôm nay (9.8); giờ để trống buộc người dùng chọn trong khung làm việc.
  const [fromDate, setFromDate] = useState(todayLocal);
  const [fromTime, setFromTime] = useState('');
  const [toDate, setToDate] = useState(todayLocal);
  const [toTime, setToTime] = useState('');
  const from = fromDate && fromTime ? `${fromDate}T${fromTime}` : '';
  const to = toDate && toTime ? `${toDate}T${toTime}` : '';
  const [typeFilter, setTypeFilter] = useState('');
  const [assetTypes, setAssetTypes] = useState<string[]>([]);
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const durationMs =
    from && to ? new Date(to).getTime() - new Date(from).getTime() : 0;
  const isLong = durationMs > MAX_DURATION_AUTO_MS;
  // 9.8: CN khóa (cả ngày nhận lẫn ngày trả). Ngoài khung giờ để BE + min/max input chặn.
  const weekendBlocked = isSunday(fromDate) || isSunday(toDate);

  useEffect(() => {
    fetch('/api/booking/asset-types')
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
      .then(setAssetTypes)
      .catch(() => setAssetTypes([]));
  }, []);

  // Admin: tìm người mượn server-side (mẫu asset-form)
  useEffect(() => {
    if (!isAdmin || !userQuery) {
      setUserOptions([]);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/users?search=${encodeURIComponent(userQuery)}&page=1&pageSize=20`,
        { signal: c.signal },
      )
        .then(async (r) => {
          if (!r.ok) return;
          const body = (await r.json()) as { items?: UserOption[] };
          // chỉ member (tạo hộ cho member) — admin/sa không đi luồng mượn
          setUserOptions(
            (body.items ?? []).filter(
              (u) => (u as { role?: string }).role === 'member',
            ),
          );
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [isAdmin, userQuery]);

  // Availability tự gợi ý (debounce) khi đổi giờ/loại — chỉ mode Thường/Nâng cao
  const searchKey =
    mode !== 'recurring' && from && to && !weekendBlocked
      ? `${from}|${to}|${typeFilter}`
      : '';
  useEffect(() => {
    // Đổi khung/loại → bỏ máy đã chọn (chống đặt máy chỉ rảnh ở khung cũ — guard stale, review 7.5)
    setAssetId('');
    if (!searchKey) {
      setMachines(null);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      const fromIso = new Date(from).toISOString();
      const toIso = new Date(to).toISOString();
      const typeQ = typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : '';
      fetch(
        `/api/booking/availability?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}${typeQ}`,
        { signal: c.signal },
      )
        .then(async (r) => {
          const list = r.ok ? ((await r.json()) as FreeMachine[]) : [];
          setMachines(list);
          // 9.5: mở từ bảng máy trống → tự chọn đúng máy nếu nó còn rảnh ở khung vừa chọn.
          if (presetAssetId && list.some((m) => m.id === presetAssetId)) {
            setAssetId(presetAssetId);
          }
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [searchKey, from, to, typeFilter, presetAssetId]);

  const longBlocked = mode === 'normal' && isLong; // Thường không được >2 ngày

  const submit = useCallback(async () => {
    setError(null);
    if (!assetId || !from || !to) {
      setError(t('bookingSheet.errMissing'));
      return;
    }
    if (weekendBlocked) {
      setError(t('bookingSheet.errWeekend'));
      return;
    }
    if (isAdmin && !borrower) {
      setError(t('bookingSheet.errNoBorrower'));
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        assetId,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      };
      let url = '/api/booking';
      if (isAdmin) {
        url = '/api/admin/tickets/create-for';
        body.borrowerSub = borrower!.sub;
        body.mode = 'schedule';
      } else if (note.trim()) {
        body.note = note.trim();
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify(body),
      });
      if (res.ok || res.status === 201) {
        onBooked();
        onClose();
        return;
      }
      const b = (await res.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      const map: Record<string, string> = {
        SLOT_TAKEN: t('booking.errSlotTaken'),
        ASSET_UNAVAILABLE: t('booking.errAssetUnavailable'),
        QUOTA_EXCEEDED: t('booking.errQuota'),
        LONG_TERM_REQUIRED: t('booking.errLongTerm'),
        OUTSIDE_WORK_HOURS: t('bookingSheet.errWorkHours'),
      };
      setError((b.code && map[b.code]) || b.message || t('booking.errGeneric'));
    } catch {
      setError(t('booking.errGeneric'));
    } finally {
      setBusy(false);
    }
  }, [
    assetId,
    from,
    to,
    weekendBlocked,
    note,
    isAdmin,
    borrower,
    me.csrfToken,
    onBooked,
    onClose,
    t,
  ]);

  const modes = useMemo(() => {
    const list: Array<{ key: Mode; enabled: boolean }> = [
      { key: 'normal', enabled: true },
      { key: 'advanced', enabled: canLong },
      { key: 'recurring', enabled: canRecur },
    ];
    return list.filter((m) => m.enabled);
  }, [canLong, canRecur]);

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <span className="sheet-title">{t('bookingSheet.title')}</span>
          <span className="spacer" />
          <button
            type="button"
            className="sheet-close"
            aria-label={t('bookingSheet.close')}
            disabled={busy}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="sheet-body">
          {/* Loại mượn — gate theo quyền */}
          <div className="segmented" style={{ marginBottom: '1rem' }}>
            {modes.map((m) => (
              <label key={m.key}>
                <input
                  type="radio"
                  name="borrowMode"
                  checked={mode === m.key}
                  onChange={() => {
                    setMode(m.key);
                    setError(null);
                  }}
                />
                {t(`bookingSheet.mode.${m.key}`)}
              </label>
            ))}
          </div>

          {error && <p className="alert error">{error}</p>}

          {/* Admin: người mượn (tạo hộ) */}
          {isAdmin && (
            <div className="form-section">
              <div className="form-section-title">
                {t('bookingSheet.borrower')}
              </div>
              {borrower ? (
                <span className="chip">
                  {borrower.fullName ?? borrower.sub}
                  <button
                    type="button"
                    aria-label={t('bookingSheet.close')}
                    onClick={() => setBorrower(null)}
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <Combobox
                  placeholder={t('bookingSheet.borrowerSearch')}
                  query={userQuery}
                  onQuery={setUserQuery}
                  options={userOptions}
                  getKey={(u) => u.sub}
                  renderOption={(u) => (
                    <>
                      <span>{u.fullName ?? u.sub}</span>
                      {u.email && <small>{u.email}</small>}
                    </>
                  )}
                  onSelect={(u) => {
                    setBorrower(u);
                    setUserQuery('');
                    setUserOptions([]);
                  }}
                />
              )}
            </div>
          )}

          {/* Ghi chú (member; admin không có ô này) — phòng ban đã ẩn (9.7). */}
          {mode !== 'recurring' && !isAdmin && (
            <div className="form-grid" style={{ marginBottom: '1rem' }}>
              <label className="field span-2">
                <span>{t('bookingSheet.note')}</span>
                <input
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            </div>
          )}

          {mode === 'recurring' ? (
            isAdmin ? (
              <RecurringAdminBuilder
                me={me}
                borrowerSub={borrower?.sub ?? ''}
                departmentId=""
                onBooked={() => {
                  onBooked();
                  onClose();
                }}
              />
            ) : (
              <RecurringBuilder
                me={me}
                onDone={() => {
                  onBooked();
                  onClose();
                }}
              />
            )
          ) : (
            <>
              <div
                className="form-grid"
                style={{
                  marginBottom: '0.75rem',
                  // Ép 2 cột → mỗi hàng một cặp: Nhận (Ngày|Giờ), Trả (Ngày|Giờ)
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                }}
              >
                <label className="field">
                  <span>{t('bookingSheet.pickupDate')}</span>
                  <input
                    type="date"
                    min={todayLocal()}
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t('bookingSheet.pickupTime')}</span>
                  <input
                    type="time"
                    min={
                      fromDate === todayLocal()
                        ? nowTimeLocal() > WORK_START
                          ? nowTimeLocal()
                          : WORK_START
                        : WORK_START
                    }
                    max={WORK_END}
                    value={fromTime}
                    onChange={(e) => setFromTime(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t('bookingSheet.returnDate')}</span>
                  <input
                    type="date"
                    min={fromDate || todayLocal()}
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t('bookingSheet.returnTime')}</span>
                  <input
                    type="time"
                    min={WORK_START}
                    max={WORK_END}
                    value={toTime}
                    onChange={(e) => setToTime(e.target.value)}
                  />
                </label>
              </div>
              {/* #3: chọn nhanh giờ nhận bằng chip (vẫn giữ ô giờ để tùy chỉnh). */}
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                  marginBottom: '0.6rem',
                }}
              >
                {PICKUP_SLOTS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={fromTime === s ? 'primary sm' : 'ghost sm'}
                    onClick={() => setFromTime(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {weekendBlocked && (
                <p className="alert warn">{t('bookingSheet.errWeekend')}</p>
              )}
              {longBlocked && (
                <p className="alert warn">{t('bookingSheet.needAdvanced')}</p>
              )}

              {/* Filter loại NGAY TRÊN danh sách máy trống */}
              <div className="filter-bar" style={{ marginBottom: '0.5rem' }}>
                <label className="field">
                  <span>{t('bookingSheet.typeFilter')}</span>
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                  >
                    <option value="">{t('bookingSheet.allTypes')}</option>
                    {assetTypes.map((ty) => (
                      <option key={ty} value={ty}>
                        {ty}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {machines === null ? (
                <p className="muted">{t('bookingSheet.pickTime')}</p>
              ) : machines.length === 0 ? (
                <p className="muted">{t('booking.empty')}</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>{t('booking.colCode')}</th>
                        <th>{t('booking.colType')}</th>
                        <th>{t('booking.colConfig')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {machines.map((m) => (
                        <tr key={m.id}>
                          <td>
                            <input
                              type="radio"
                              name="pickAsset"
                              checked={assetId === m.id}
                              onChange={() => setAssetId(m.id)}
                            />
                          </td>
                          <td>
                            <span className="mono">{m.code}</span>
                          </td>
                          <td>{m.type}</td>
                          <td>{m.configuration ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* #3: báo policy duyệt theo thời lượng (≤2 ngày tự duyệt / >2 ngày Admin). */}
              {assetId && from && to && !weekendBlocked && (
                <p
                  style={{
                    marginTop: '0.7rem',
                    marginBottom: 0,
                    fontWeight: 600,
                    fontSize: '0.85rem',
                    color: isLong ? 'var(--warn)' : 'var(--ok)',
                  }}
                >
                  {isLong
                    ? `⏳ ${t('bookingSheet.hintAdmin', 'Mượn hơn 2 ngày — cần Admin duyệt trước khi nhận.')}`
                    : `✔ ${t('bookingSheet.hintAuto', 'Mượn ≤ 2 ngày — tự duyệt, nhận ngay.')}`}
                </p>
              )}
            </>
          )}
        </div>

        {mode !== 'recurring' && (
          <div className="sheet-footer">
            <span className="spacer" />
            <button type="button" disabled={busy} onClick={onClose}>
              {t('bookingSheet.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || longBlocked || weekendBlocked || !assetId}
              onClick={() => void submit()}
            >
              {busy && <span className="spinner" style={{ marginRight: 6 }} />}
              {t('bookingSheet.submit')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface SessionRow {
  from: string;
  to: string;
}

/** Admin đặt định kỳ hộ (7.5) — builder buổi + máy (theo buổi đầu) → recurring-for. */
function RecurringAdminBuilder({
  me,
  borrowerSub,
  departmentId,
  onBooked,
}: {
  me: Me;
  borrowerSub: string;
  departmentId: string;
  onBooked: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionRow[]>([{ from: '', to: '' }]);
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const setRow = (i: number, patch: Partial<SessionRow>) =>
    setSessions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const valid =
    sessions.length > 0 && sessions.every((s) => s.from && s.to && s.to > s.from);

  const findMachines = useCallback(async () => {
    const s0 = sessions[0];
    if (!s0?.from || !s0?.to) return;
    setAssetId(''); // đổi buổi → bỏ máy đã chọn (chống stale)
    try {
      const res = await fetch(
        `/api/booking/availability?from=${encodeURIComponent(new Date(s0.from).toISOString())}&to=${encodeURIComponent(new Date(s0.to).toISOString())}`,
      );
      if (res.ok) setMachines((await res.json()) as FreeMachine[]);
    } catch {
      /* ignore */
    }
  }, [sessions]);

  const submit = useCallback(async () => {
    setMsg(null);
    if (!borrowerSub) {
      setMsg({ ok: false, text: t('bookingSheet.errNoBorrower') });
      return;
    }
    if (!assetId || !valid) {
      setMsg({ ok: false, text: t('bookingSheet.errMissing') });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/tickets/recurring-for', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify({
          borrowerSub,
          assetId,
          sessions: sessions.map((s) => ({
            from: new Date(s.from).toISOString(),
            to: new Date(s.to).toISOString(),
          })),
          ...(departmentId ? { departmentId } : {}),
        }),
      });
      if (res.status === 201) {
        onBooked();
        return;
      }
      const b = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg({ ok: false, text: b.message ?? t('booking.errGeneric') });
    } catch {
      setMsg({ ok: false, text: t('booking.errGeneric') });
    } finally {
      setBusy(false);
    }
  }, [borrowerSub, assetId, valid, sessions, departmentId, me.csrfToken, onBooked, t]);

  return (
    <div className="form-section">
      <div className="form-section-title">{t('bookingSheet.recurringSessions')}</div>
      {sessions.map((s, i) => (
        <div key={i} className="form-grid" style={{ marginBottom: '0.5rem' }}>
          <label className="field">
            <span>{t('booking.from')}</span>
            <input
              type="datetime-local"
              value={s.from}
              onChange={(e) => setRow(i, { from: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('booking.to')}</span>
            <input
              type="datetime-local"
              value={s.to}
              onChange={(e) => setRow(i, { to: e.target.value })}
            />
          </label>
          {sessions.length > 1 && (
            <button
              type="button"
              className="sm"
              onClick={() =>
                setSessions((rows) => rows.filter((_, j) => j !== i))
              }
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, margin: '0.5rem 0' }}>
        <button
          type="button"
          className="sm"
          disabled={sessions.length >= 30}
          onClick={() => setSessions((r) => [...r, { from: '', to: '' }])}
        >
          {t('bookingSheet.addSession')}
        </button>
        <button
          type="button"
          className="sm"
          disabled={!valid}
          onClick={() => void findMachines()}
        >
          {t('bookingSheet.findMachine')}
        </button>
      </div>
      {machines !== null && (
        <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          <option value="">{t('bookingSheet.pickMachine')}</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code} — {m.type}
            </option>
          ))}
        </select>
      )}
      {msg && <p className={`alert ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}
      <div style={{ marginTop: '0.75rem' }}>
        <button
          type="button"
          className="primary"
          disabled={busy || !assetId}
          onClick={() => void submit()}
        >
          {t('bookingSheet.submit')}
        </button>
      </div>
    </div>
  );
}

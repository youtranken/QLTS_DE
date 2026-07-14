import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import { DatePicker } from './ui/date-picker';
import { RecurringBuilder } from './recurring-builder';
import type { Me } from './panels';

const MAX_DURATION_AUTO_MS = 48 * 60 * 60 * 1000;
// Khung giờ làm việc (9.8): chỉ cho đặt 07:00–18:00, T2–T7 (CN khóa). Giờ VN (UTC+7 cố định).
const WORK_START = '07:00';
const WORK_END = '18:00';
// #3: khung giờ nhận nhanh (chip) trong giờ làm việc. Export để catalog (borrow-board)
// tính "giờ trống" trên ĐÚNG các khung này — nhất quán giữa thẻ máy và popup.
export const PICKUP_SLOTS = ['08:00', '09:00', '10:00', '13:00', '14:00', '15:00'];
/** Ngày local (YYYY-MM-DD) theo tz máy — dùng cho default + min của input date. */
const todayLocal = (): string => new Date().toLocaleDateString('en-CA');
/** HH:MM local hiện tại — chặn chọn giờ đã qua trong hôm nay. */
const nowTimeLocal = (): string =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** true nếu chuỗi YYYY-MM-DD rơi vào Chủ nhật (local). */
const isSunday = (d: string): boolean =>
  d ? new Date(`${d}T00:00`).getDay() === 0 : false;
/**
 * Ngày NHẬN mặc định khi mở popup: hôm nay nếu còn trong giờ làm; nếu đã quá 18:00
 * (hoặc Chủ nhật) thì nhảy sang ngày làm kế — tránh mở popup ngoài giờ mà ô Giờ nhận
 * hôm nay bị min>max không chọn được (user phải tự đổi ngày).
 */
const nextBookableDate = (): string => {
  const d = new Date();
  if (nowTimeLocal() >= WORK_END) d.setDate(d.getDate() + 1); // hết giờ hôm nay → mai
  while (d.getDay() === 0) d.setDate(d.getDate() + 1); // bỏ qua Chủ nhật
  return d.toLocaleDateString('en-CA');
};

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
  presetMachine,
}: {
  me: Me;
  onClose: () => void;
  onBooked: () => void;
  /**
   * Mở từ thẻ "Máy có thể mượn" → máy ĐÃ chọn sẵn (khóa), chỉ cần chọn giờ. Mở từ nút
   * "Đặt máy"/"Nâng cao" (không truyền) → duyệt & chọn máy trong danh sách rảnh.
   */
  presetMachine?: FreeMachine;
}) {
  const { t } = useTranslation();
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  const canLong = isAdmin || (me.permissions?.canLongTerm ?? false);
  const canRecur = isAdmin || (me.permissions?.canRecurring ?? false);

  const [mode, setMode] = useState<Mode>('normal');
  const [note, setNote] = useState('');
  // Admin tạo hộ: người mượn — MẶC ĐỊNH là người đang đăng nhập (đổi được qua tìm kiếm).
  const [borrower, setBorrower] = useState<UserOption | null>(
    isAdmin
      ? { sub: me.sub, fullName: me.fullName ?? me.sub, email: me.email ?? null }
      : null,
  );
  const [userQuery, setUserQuery] = useState('');
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  // Thường/Nâng cao — tách Ngày + Giờ cho Nhận/Trả (4 ô), gộp lại thành datetime khi dùng.
  const [fromDate, setFromDate] = useState(nextBookableDate);
  const [fromTime, setFromTime] = useState('');
  const [toDate, setToDate] = useState(nextBookableDate);
  const [toTime, setToTime] = useState('');
  const from = fromDate && fromTime ? `${fromDate}T${fromTime}` : '';
  const to = toDate && toTime ? `${toDate}T${toTime}` : '';
  // machines = máy RẢNH trong khung (chỉ để cảnh báo nếu máy đã chọn bị bận).
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState(presetMachine?.id ?? '');
  // poolList = mọi máy pool cho dropdown "Đổi máy"; editMachine = đang mở dropdown.
  const [poolList, setPoolList] = useState<FreeMachine[]>([]);
  const [editMachine, setEditMachine] = useState(!presetMachine);
  // Chip giờ áp cho ô đang thao tác: 'from' (giờ nhận) hoặc 'to' (giờ trả).
  const [slotTarget, setSlotTarget] = useState<'from' | 'to'>('from');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const durationMs =
    from && to ? new Date(to).getTime() - new Date(from).getTime() : 0;
  const isLong = durationMs > MAX_DURATION_AUTO_MS;
  // Giờ trả PHẢI sau giờ nhận (chặn nhận 10:00 → trả 08:00 cùng ngày, duration ≤ 0).
  const invalidRange = !!from && !!to && durationMs <= 0;
  // 9.8: CN khóa (cả ngày nhận lẫn ngày trả). Ngoài khung giờ để BE + min/max input chặn.
  const weekendBlocked = isSunday(fromDate) || isSunday(toDate);

  // Danh sách máy pool cho dropdown "Đổi máy" (chọn máy khác trong pool).
  useEffect(() => {
    fetch('/api/booking/pool-all-machines')
      .then((r) => (r.ok ? (r.json() as Promise<FreeMachine[]>) : []))
      .then(setPoolList)
      .catch(() => setPoolList([]));
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

  // Availability (debounce) — chỉ để CẢNH BÁO nếu máy đã chọn bị bận ở khung này.
  const searchKey =
    mode !== 'recurring' && from && to && !weekendBlocked && !invalidRange
      ? `${from}|${to}`
      : '';
  useEffect(() => {
    if (!searchKey) {
      setMachines(null);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      const fromIso = new Date(from).toISOString();
      const toIso = new Date(to).toISOString();
      fetch(
        `/api/booking/availability?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
        { signal: c.signal },
      )
        .then(async (r) => {
          const list = r.ok ? ((await r.json()) as FreeMachine[]) : [];
          setMachines(list);
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [searchKey, from, to]);

  // Cảnh báo khi MÁY ĐÃ CHỌN không còn rảnh ở khung giờ vừa chọn.
  const selectedBusy =
    !!assetId &&
    machines !== null &&
    !!from &&
    !!to &&
    !weekendBlocked &&
    !invalidRange &&
    !machines.some((m) => m.id === assetId);
  const selected = poolList.find((m) => m.id === assetId) ?? presetMachine ?? null;

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
    if (invalidRange) {
      setError(t('bookingSheet.errOrder', 'Giờ trả phải sau giờ nhận.'));
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
        if (note.trim()) body.note = note.trim();
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
    invalidRange,
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

          {/* Hàng trên: Người mượn (admin) + Máy trên CÙNG 1 hàng. Máy = chip + "Đổi máy";
              bấm Đổi máy → dropdown chọn máy khác trong pool (scroll), không nhảy bảng. */}
          <div className="sheet-toprow">
            {isAdmin && (
              <div className="topcell">
                <span className="topcell-label">
                  {t('bookingSheet.borrower')}
                </span>
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
            <div className="topcell">
              <span className="topcell-label">
                {t('bookingSheet.machine', 'Máy')}
              </span>
              {editMachine || !selected ? (
                <select
                  className="machine-select"
                  value={assetId}
                  onChange={(e) => {
                    setAssetId(e.target.value);
                    if (e.target.value) setEditMachine(false);
                  }}
                >
                  <option value="">
                    {t('bookingSheet.pickMachine', '— Chọn máy —')}
                  </option>
                  {poolList.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.code} · {m.type}
                      {m.configuration ? ` · ${m.configuration}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="picked-machine compact">
                  <span className="pm-ico">🖥️</span>
                  <div className="pm-info">
                    <span className="mono pm-code">{selected.code}</span>
                    <span className="muted pm-spec">
                      {selected.type}
                      {selected.configuration
                        ? ` · ${selected.configuration}`
                        : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ghost sm"
                    onClick={() => setEditMachine(true)}
                  >
                    {t('bookingSheet.changeMachine', 'Đổi máy')}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Ghi chú — cho cả member lẫn admin (create-for nhận note). Phòng ban đã ẩn (9.7). */}
          {mode !== 'recurring' && (
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
                  <DatePicker
                    min={todayLocal()}
                    value={fromDate}
                    clearable={false}
                    ariaLabel={t('bookingSheet.pickupDate')}
                    onChange={setFromDate}
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
                    onFocus={() => setSlotTarget('from')}
                    onChange={(e) => setFromTime(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t('bookingSheet.returnDate')}</span>
                  <DatePicker
                    min={fromDate || todayLocal()}
                    value={toDate}
                    clearable={false}
                    ariaLabel={t('bookingSheet.returnDate')}
                    onChange={setToDate}
                  />
                </label>
                <label className="field">
                  <span>{t('bookingSheet.returnTime')}</span>
                  <input
                    type="time"
                    min={
                      toDate === fromDate && fromTime ? fromTime : WORK_START
                    }
                    max={WORK_END}
                    value={toTime}
                    onFocus={() => setSlotTarget('to')}
                    onChange={(e) => setToTime(e.target.value)}
                  />
                </label>
              </div>
              {/* Chip giờ gợi ý: áp vào ô ĐANG chọn (nhận/trả). 7 chip nhỏ gọn trên 1 hàng. */}
              <div className="slot-suggest">
                <span className="slot-suggest-label">
                  {slotTarget === 'from'
                    ? t('bookingSheet.suggestFrom', 'Gợi ý giờ nhận')
                    : t('bookingSheet.suggestTo', 'Gợi ý giờ trả')}
                </span>
                <div className="slot-suggest-chips">
                  {(() => {
                    // Hôm nay: chỉ gợi ý giờ SAU giờ hiện tại (13:30 → ẩn 08–13, còn 14,15).
                    // Giờ trả cùng ngày nhận: phải sau giờ nhận đã chọn.
                    const activeDate = slotTarget === 'from' ? fromDate : toDate;
                    const isToday = activeDate === todayLocal();
                    const nowT = nowTimeLocal();
                    const chips = PICKUP_SLOTS.filter((s) => {
                      if (isToday && s < nowT) return false;
                      if (
                        slotTarget === 'to' &&
                        toDate === fromDate &&
                        fromTime &&
                        s <= fromTime
                      )
                        return false;
                      return true;
                    });
                    if (chips.length === 0) {
                      return (
                        <span className="muted" style={{ fontSize: '0.82rem' }}>
                          {t('bookingSheet.noSlotToday', 'Hết giờ gợi ý — chọn ngày khác.')}
                        </span>
                      );
                    }
                    const cur = slotTarget === 'from' ? fromTime : toTime;
                    return chips.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`slot-pick${cur === s ? ' on' : ''}`}
                        onClick={() =>
                          slotTarget === 'from' ? setFromTime(s) : setToTime(s)
                        }
                      >
                        {s}
                      </button>
                    ));
                  })()}
                </div>
              </div>
              {weekendBlocked && (
                <p className="alert warn">{t('bookingSheet.errWeekend')}</p>
              )}
              {invalidRange && (
                <p className="alert warn">
                  {t('bookingSheet.errOrder', 'Giờ trả phải sau giờ nhận.')}
                </p>
              )}
              {longBlocked && (
                <p className="alert warn">{t('bookingSheet.needAdvanced')}</p>
              )}

              {selectedBusy && (
                <p className="alert warn">
                  {t(
                    'bookingSheet.presetBusy',
                    'Máy này đã bận ở khung giờ vừa chọn — đổi khung hoặc đổi máy.',
                  )}
                </p>
              )}

              {/* #3: báo policy duyệt theo thời lượng (≤2 ngày tự duyệt / >2 ngày Admin). */}
              {assetId && from && to && !weekendBlocked && !invalidRange && (
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
              disabled={
                busy ||
                longBlocked ||
                weekendBlocked ||
                invalidRange ||
                !assetId ||
                selectedBusy
              }
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
  onBooked,
}: {
  me: Me;
  borrowerSub: string;
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
  }, [borrowerSub, assetId, valid, sessions, me.csrfToken, onBooked, t]);

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

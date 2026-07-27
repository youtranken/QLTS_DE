import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RecurringBuilder } from '@/features/booking/recurring-builder';
import { RecurringAdminBuilder } from '@/features/tickets/recurring-admin-builder';
import { BookingTimeFields } from '@/features/booking/booking-time-fields';
import { BookingTopRow } from '@/features/booking/booking-top-row';
import { Dialog, DialogTitle, DialogClose } from '@/ui/dialog';
import type { Me } from '@/lib/me';
import {
  DEFAULT_WORK_HOURS,
  isBlockedDay,
  addDays,
  nextBookableDate,
  type FreeMachine,
  type Mode,
  type UserOption,
} from '@/features/booking/booking-types';

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
  // Giờ làm + ngưỡng auto-duyệt từ config SA chỉnh (audit H2/H3); fallback nếu /me chưa nạp.
  const wh = me.workingHours ?? DEFAULT_WORK_HOURS;
  const autoMs = (me.autoApproveMaxHours ?? 48) * 3_600_000;

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
  const [fromDate, setFromDate] = useState(() => nextBookableDate(wh));
  const [fromTime, setFromTime] = useState('');
  const [toDate, setToDate] = useState(() => nextBookableDate(wh));
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
  const isLong = durationMs > autoMs;
  // Giờ trả PHẢI sau giờ nhận (chặn nhận 10:00 → trả 08:00 cùng ngày, duration ≤ 0).
  const invalidRange = !!from && !!to && durationMs <= 0;
  // Khóa ngày KHÔNG thuộc ngày làm việc config (mặc định chỉ CN). Ngoài khung giờ để BE +
  // min/max input chặn. Theo config SA chỉnh (audit H3) thay vì hardcode Chủ nhật.
  const weekendBlocked =
    isBlockedDay(fromDate, wh.days) || isBlockedDay(toDate, wh.days);

  // Thường (≤2 ngày): ngày trả DO USER CHỌN nhưng chỉ trong 1–2 ngày gần nhất sau ngày nhận
  // (cửa sổ [nhận .. nhận+2], tự-duyệt/dài tính theo thời lượng thực). KHÔNG mặc định +2 nữa;
  // chỉ kẹp về ngày nhận khi ngày trả rơi ngoài cửa sổ (đổi ngày nhận). Nâng cao/Định kỳ tự do.
  useEffect(() => {
    if (mode !== 'normal' || !fromDate) return;
    const hi = addDays(fromDate, 2);
    if (!toDate || toDate < fromDate || toDate > hi) setToDate(fromDate);
  }, [mode, fromDate, toDate]);

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
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      dismissible={!busy}
    >
      <div className="sheet-header">
        <DialogTitle className="sheet-title">{t('bookingSheet.title')}</DialogTitle>
        <span className="spacer" />
        <DialogClose asChild>
          <button
            type="button"
            className="sheet-close"
            aria-label={t('bookingSheet.close')}
            disabled={busy}
          >
            ✕
          </button>
        </DialogClose>
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

          {/* Hàng trên: Người mượn (admin) + Máy trên CÙNG 1 hàng. */}
          <BookingTopRow
            isAdmin={isAdmin}
            borrower={borrower}
            setBorrower={setBorrower}
            userQuery={userQuery}
            setUserQuery={setUserQuery}
            userOptions={userOptions}
            setUserOptions={setUserOptions}
            assetId={assetId}
            setAssetId={setAssetId}
            poolList={poolList}
            selected={selected}
            editMachine={editMachine}
            setEditMachine={setEditMachine}
          />

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
            <BookingTimeFields
              fromDate={fromDate}
              fromTime={fromTime}
              toDate={toDate}
              toTime={toTime}
              setFromDate={setFromDate}
              setFromTime={setFromTime}
              setToDate={setToDate}
              setToTime={setToTime}
              slotTarget={slotTarget}
              setSlotTarget={setSlotTarget}
              weekendBlocked={weekendBlocked}
              invalidRange={invalidRange}
              longBlocked={longBlocked}
              isLong={isLong}
              selectedBusy={selectedBusy}
              assetId={assetId}
              from={from}
              to={to}
              bookableDays={wh.days}
              returnMax={mode === 'normal' && fromDate ? addDays(fromDate, 2) : undefined}
              returnCapMs={
                mode === 'normal' && from
                  ? new Date(from).getTime() + autoMs
                  : undefined
              }
            />
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
    </Dialog>
  );
}

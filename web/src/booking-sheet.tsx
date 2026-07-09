import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import { RecurringBuilder } from './recurring-builder';
import type { Me } from './panels';

const MAX_DURATION_AUTO_MS = 48 * 60 * 60 * 1000;

interface Department {
  id: string;
  name: string;
}
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
}: {
  me: Me;
  onClose: () => void;
  onBooked: () => void;
}) {
  const { t } = useTranslation();
  const isAdmin = me.role === 'admin' || me.role === 'sa';
  const canLong = isAdmin || (me.permissions?.canLongTerm ?? false);
  const canRecur = isAdmin || (me.permissions?.canRecurring ?? false);

  const [mode, setMode] = useState<Mode>('normal');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState('');
  const [note, setNote] = useState('');
  // Admin tạo hộ: người mượn
  const [borrower, setBorrower] = useState<UserOption | null>(null);
  const [userQuery, setUserQuery] = useState('');
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  // Thường/Nâng cao
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [assetTypes, setAssetTypes] = useState<string[]>([]);
  const [machines, setMachines] = useState<FreeMachine[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const durationMs =
    from && to ? new Date(to).getTime() - new Date(from).getTime() : 0;
  const isLong = durationMs > MAX_DURATION_AUTO_MS;

  useEffect(() => {
    fetch('/api/departments')
      .then((r) => (r.ok ? (r.json() as Promise<Department[]>) : []))
      .then(setDepartments)
      .catch(() => setDepartments([]));
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
  const searchKey = mode !== 'recurring' && from && to ? `${from}|${to}|${typeFilter}` : '';
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
          setMachines(r.ok ? ((await r.json()) as FreeMachine[]) : []);
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [searchKey, from, to, typeFilter]);

  const longBlocked = mode === 'normal' && isLong; // Thường không được >2 ngày

  const submit = useCallback(async () => {
    setError(null);
    if (!assetId || !from || !to) {
      setError(t('bookingSheet.errMissing'));
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
        ...(departmentId ? { departmentId } : {}),
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
        DEPARTMENT_INVALID: t('bookingSheet.errDept'),
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
    departmentId,
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

          {/* Phòng ban + Ghi chú (chung mọi loại) */}
          <div className="form-grid" style={{ marginBottom: '1rem' }}>
            <label className="field">
              <span>{t('bookingSheet.department')}</span>
              <select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
              >
                <option value="">{t('bookingSheet.noDepartment')}</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {mode !== 'recurring' && !isAdmin && (
              <label className="field span-2">
                <span>{t('bookingSheet.note')}</span>
                <input
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            )}
          </div>

          {mode === 'recurring' ? (
            isAdmin ? (
              <RecurringAdminBuilder
                me={me}
                borrowerSub={borrower?.sub ?? ''}
                departmentId={departmentId}
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
              <div className="form-grid" style={{ marginBottom: '0.75rem' }}>
                <label className="field">
                  <span>{t('booking.from')}</span>
                  <input
                    type="datetime-local"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t('booking.to')}</span>
                  <input
                    type="datetime-local"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </div>
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
              disabled={busy || longBlocked || !assetId}
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

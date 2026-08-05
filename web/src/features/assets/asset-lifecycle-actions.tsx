import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AssetCascadeDialog } from '@/features/assets/asset-cascade-dialog';
import { DatePicker } from '@/ui/date-picker';
import type {
  AssetRow,
  CascadePreview,
  PendingCascade,
} from '@/lib/asset-types';
import type { RowAction } from '@/features/assets/asset-row-actions';
import type { Me } from '@/lib/me';

type Method = 'POST' | 'PUT';

/**
 * Thao tác vòng đời máy TỪ kebab của /tai-san (UAT): Khóa sửa chữa (popup ETA) / Mở khóa /
 * Đưa-Gỡ pool. Khóa CHỈ cho máy pool; ETA bắt buộc → sweep auto-unlock khi tới ngày.
 * Gói version-fetch (list không trả version) + preview cascade + popup xác nhận vào 1 hook.
 */
export function useAssetLifecycle({
  me,
  onChanged,
}: {
  me: Me;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockRow, setLockRow] = useState<{ row: AssetRow; version: number } | null>(
    null,
  );
  const [lockEta, setLockEta] = useState('');
  const [lockReason, setLockReason] = useState('');
  const [cascade, setCascade] = useState<PendingCascade | null>(null);
  const [notifyUsers, setNotifyUsers] = useState(true);
  // Giữ máy đích cho cascade dialog (dialog nuốt path/method/extra, không mang id/version).
  const target = useRef<{ id: string; version: number } | null>(null);

  const headers = {
    'Content-Type': 'application/json',
    ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
  };

  const fetchVersion = useCallback(
    async (id: string): Promise<number | null> => {
      try {
        const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        return ((await res.json()) as { version: number }).version;
      } catch {
        return null;
      }
    },
    [],
  );

  const run = useCallback(
    async (
      id: string,
      version: number,
      path: string,
      method: Method,
      extra: Record<string, unknown>,
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(id)}/${path}`,
          { method, headers, body: JSON.stringify({ ...extra, version }) },
        );
        if (res.ok) {
          onChanged();
          return true;
        }
        const b = (await res.json().catch(() => ({}))) as {
          code?: string;
          message?: string;
        };
        setError(
          b.code === 'STALE_VERSION'
            ? t('assets.staleVersion')
            : (b.message ?? t('assets.saveFailed')),
        );
        return false;
      } catch {
        setError(t('app.serverUnreachable'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    // headers phụ thuộc csrfToken (ổn định) — cố ý không đưa vào deps để tránh tạo lại
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me.csrfToken, onChanged, t],
  );

  // Khóa / Gỡ pool có thể hủy booking tương lai → preview trước, có ảnh hưởng thì mở popup.
  const previewThenRun = useCallback(
    async (
      id: string,
      version: number,
      path: string,
      method: Method,
      extra: Record<string, unknown>,
    ) => {
      try {
        const res = await fetch(
          `/api/admin/assets/${encodeURIComponent(id)}/lifecycle-preview`,
        );
        if (res.ok) {
          const data = (await res.json()) as CascadePreview;
          if (data.futureCancellations.length > 0 || data.inUseRecalls.length > 0) {
            target.current = { id, version };
            setNotifyUsers(true);
            setCascade({ path, method, extra, patch: {}, data });
            return;
          }
        }
      } catch {
        /* preview lỗi → không chặn, chạy thẳng */
      }
      await run(id, version, path, method, extra);
    },
    [run],
  );

  // Bọc: lấy version tươi rồi chạy fn (dùng cho Mở khóa / Pool toggle).
  const withVersion = useCallback(
    async (row: AssetRow, fn: (version: number) => void | Promise<unknown>) => {
      setError(null);
      const v = await fetchVersion(row.id);
      if (v == null) {
        setError(t('assets.loadFailed'));
        return;
      }
      await fn(v);
    },
    [fetchVersion, t],
  );

  const openLock = useCallback(
    async (row: AssetRow) => {
      setError(null);
      const v = await fetchVersion(row.id);
      if (v == null) {
        setError(t('assets.loadFailed'));
        return;
      }
      setLockEta('');
      setLockReason('');
      setLockRow({ row, version: v });
    },
    [fetchVersion, t],
  );

  /** Danh sách action vòng đời cho kebab của MỘT dòng (chỉ máy; theo trạng thái + pool). */
  const actionsFor = useCallback(
    (row: AssetRow): RowAction[] => {
      if (row.type === 'software' || row.status === 'disposed') return [];
      const items: RowAction[] = [];
      if (row.status === 'locked_repair') {
        items.push({
          label: t('assets.unlockAction'),
          icon: 'unlock',
          onClick: () =>
            void withVersion(row, (v) => run(row.id, v, 'unlock', 'POST', {})),
        });
      }
      if (row.status === 'in_use') {
        // Khóa sửa chữa CHỈ cho máy pool (yêu cầu UAT).
        if (row.isPool) {
          items.push({
            label: t('assets.lockAction'),
            icon: 'lock',
            onClick: () => void openLock(row),
          });
          items.push({
            label: t('assets.poolOff'),
            icon: 'poolOff',
            onClick: () =>
              void withVersion(row, (v) =>
                previewThenRun(row.id, v, 'pool', 'PUT', { isPool: false }),
              ),
          });
        } else {
          items.push({
            label: t('assets.poolOn'),
            icon: 'poolOn',
            onClick: () =>
              void withVersion(row, (v) =>
                run(row.id, v, 'pool', 'PUT', { isPool: true }),
              ),
          });
        }
      }
      return items;
    },
    [t, withVersion, run, previewThenRun, openLock],
  );

  const submitLock = useCallback(() => {
    if (!lockRow || !lockReason.trim() || !lockEta) return;
    const { row, version } = lockRow;
    setLockRow(null);
    void previewThenRun(row.id, version, 'lock', 'POST', {
      reason: lockReason.trim(),
      eta: lockEta,
    });
  }, [lockRow, lockReason, lockEta, previewThenRun]);

  const overlay = (
    <>
      {error && (
        <div className="lifecycle-toast alert error" role="alert">
          {error}
          <button
            type="button"
            aria-label={t('assets.cancel')}
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}

      {lockRow && (
        <div
          className="modal-backdrop"
          onClick={() => setLockRow(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setLockRow(null);
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: '0.75rem' }}>
              {t('assets.lockAction')} ·{' '}
              <span className="mono">{lockRow.row.code}</span>
            </h2>
            <label className="field" style={{ marginBottom: '0.75rem' }}>
              <span>
                {t('assets.lockReason')} <span className="field-req">*</span>
              </span>
              <input
                autoFocus
                maxLength={500}
                value={lockReason}
                onChange={(e) => setLockReason(e.target.value)}
              />
            </label>
            <label className="field" style={{ marginBottom: '0.5rem' }}>
              <span>
                {t('assets.lockEta')} <span className="field-req">*</span>
              </span>
              {/* ETA bắt buộc & phải SAU hôm nay (min=ngày mai) → sweep auto-unlock mỗi 60s,
                  chọn hôm nay/quá khứ sẽ mở lại tức thì (BE cũng chặn LOCK_ETA_PAST). */}
              <DatePicker
                value={lockEta}
                clearable={false}
                ariaLabel={t('assets.lockEta')}
                min={(() => {
                  const d = new Date();
                  d.setDate(d.getDate() + 1);
                  return d.toLocaleDateString('en-CA');
                })()}
                onChange={setLockEta}
              />
            </label>
            <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 1rem' }}>
              {t(
                'assets.lockEtaHint',
                'Tới ngày này máy tự mở khóa để mượn lại.',
              )}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setLockRow(null)}>
                {t('assets.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !lockReason.trim() || !lockEta}
                onClick={submitLock}
              >
                {t('assets.confirmLock')}
              </button>
            </div>
          </div>
        </div>
      )}

      {cascade && (
        <AssetCascadeDialog
          cascade={cascade}
          setCascade={setCascade}
          notifyUsers={notifyUsers}
          setNotifyUsers={setNotifyUsers}
          busy={busy}
          doLifecycle={(path, method, extra) => {
            const tgt = target.current;
            if (!tgt) return;
            void run(tgt.id, tgt.version, path, method as Method, extra);
          }}
        />
      )}
    </>
  );

  return { actionsFor, overlay };
}

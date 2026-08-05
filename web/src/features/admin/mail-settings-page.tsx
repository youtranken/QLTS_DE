import { useCallback, useEffect, useState } from 'react';
import type { Me } from '@/lib/me';
import { TimeField } from '@/ui/time-field';
import './mail-settings.css';

/** Nhóm hiển thị + nhãn. Các `key` khớp MAIL_TOPICS ở BE — thêm mail mới thì thêm ở đây + BE. */
const GROUPS: Array<{
  title: string;
  items: Array<{ key: string; label: string; hint: string }>;
}> = [
  {
    title: 'Duyệt & mượn',
    items: [
      { key: 'approval_requested', label: 'Yêu cầu mượn cần duyệt', hint: 'Gửi nhóm Admin' },
      { key: 'approval_reminder', label: 'Nhắc duyệt (yêu cầu treo)', hint: 'Gửi nhóm Admin' },
      { key: 'request_rejected', label: 'Từ chối yêu cầu mượn → báo người mượn', hint: 'Gửi người mượn' },
    ],
  },
  {
    title: 'Nhắc & quá hạn',
    items: [
      { key: 'due_reminder', label: 'Nhắc tới hạn trả (đúng giờ hết hạn)', hint: 'Admin + người mượn' },
      { key: 'overdue_reminder', label: 'Nhắc quá hạn trả', hint: 'Admin + người mượn' },
      { key: 'pickup_reminder', label: 'Nhắc xác nhận giao máy', hint: 'Gửi nhóm Admin' },
    ],
  },
  {
    title: 'Hủy lượt mượn',
    items: [
      { key: 'booking_cancelled', label: 'Hủy do máy (khóa/thanh lý)', hint: 'Gửi người mượn' },
      { key: 'ticket_force_cancelled', label: 'Hủy cưỡng chế (Admin hủy)', hint: 'Gửi người mượn' },
    ],
  },
  {
    title: 'Gia hạn',
    items: [
      { key: 'extension_requested', label: 'Xin gia hạn → báo Admin', hint: 'Gửi nhóm Admin' },
      { key: 'extension_rejected', label: 'Từ chối gia hạn → báo người mượn', hint: 'Gửi người mượn' },
    ],
  },
  {
    title: 'Thông báo tổng hợp',
    items: [
      { key: 'license_digest', label: 'Thông báo license sắp hết hạn', hint: 'Gửi theo giờ đã đặt' },
      { key: 'eol_digest', label: 'Thông báo máy quá hạn', hint: 'Gửi theo giờ đã đặt' },
    ],
  },
];

interface MailSettings {
  enabled: Record<string, boolean>;
  digestTime: string;
}

function Switch({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <span className="mailset-switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={on}
        onChange={onToggle}
      />
      <span className="track" aria-hidden="true" />
    </span>
  );
}

/** Panel bật/tắt từng loại mail + giờ gửi digest. Nhúng vào Cấu hình; cũng là trang riêng. */
export function MailSettingsPanel({ me }: { me: Me }) {
  const [cfg, setCfg] = useState<MailSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/config/mail');
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      if (res.ok) setCfg((await res.json()) as MailSettings);
      else setError('Không tải được cấu hình thông báo.');
    } catch {
      setError('Không kết nối được máy chủ.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isOn = (key: string) => cfg?.enabled[key] !== false;
  const toggle = (key: string) =>
    setCfg((c) =>
      c ? { ...c, enabled: { ...c.enabled, [key]: !(c.enabled[key] !== false) } } : c,
    );

  const save = useCallback(async () => {
    if (!cfg) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await fetch('/api/admin/config/mail', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
        },
        body: JSON.stringify(cfg),
      });
      if (res.ok) {
        setCfg((await res.json()) as MailSettings);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2500); // tự ẩn báo "Đã lưu"
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? 'Lưu thất bại.');
    } catch {
      setError('Không kết nối được máy chủ.');
    } finally {
      setBusy(false);
    }
  }, [cfg, me.csrfToken]);

  if (!cfg) {
    return (
      <div className="form-section">
        {error ? (
          <p className="alert error">{error}</p>
        ) : (
          <p className="muted">Đang tải…</p>
        )}
      </div>
    );
  }

  return (
    <div className="form-section">
      <div className="form-section-title">Bật/tắt email theo sự kiện</div>
      {error && <p className="alert error">{error}</p>}
      {saved && <p className="alert ok">Đã lưu.</p>}

      <div className="mailset">
        <p className="mailset-intro">
          Tắt loại nào thì hệ thống ngừng gửi email loại đó (mặc định tất cả đang bật).
        </p>

        {GROUPS.map((g) => (
          <div className="mailset-group" key={g.title}>
            <h4>{g.title}</h4>
            {g.items.map((it) => (
              <div className="mailset-row" key={it.key}>
                <span className="mailset-label">
                  <strong>{it.label}</strong>
                  <span>{it.hint}</span>
                </span>
                <Switch
                  on={isOn(it.key)}
                  onToggle={() => toggle(it.key)}
                  label={it.label}
                />
              </div>
            ))}
          </div>
        ))}

        <div className="mailset-digest">
          <span className="mailset-label">
            <strong>Giờ gửi thông báo tổng hợp</strong>
            <span>
              Theo giờ VN. Thông báo tổng hợp chỉ gửi từ giờ này trở đi trong
              ngày — mặc định 00:00 (ngay sau nửa đêm).
            </span>
          </span>
          <TimeField
            value={cfg.digestTime}
            ariaLabel="Giờ gửi thông báo tổng hợp"
            onChange={(v) => setCfg((c) => (c ? { ...c, digestTime: v } : c))}
          />
        </div>

        <div>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Trang riêng "Cấu hình thông báo" (nav riêng /admin/mail). */
export function MailSettingsPage({ me }: { me: Me }) {
  return (
    <section className="config-page admin-narrow">
      <div className="page-header">
        <h1>Cấu hình thông báo</h1>
      </div>
      <MailSettingsPanel me={me} />
    </section>
  );
}

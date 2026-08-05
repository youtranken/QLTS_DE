import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Me } from '@/lib/me';

interface SmtpState {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  configured: boolean;
  hasEncKey: boolean;
}

/**
 * Màn cấu hình SMTP (Gmail) — admin/sa. Mật khẩu WRITE-ONLY: GET không trả về, để trống khi lưu =
 * giữ mật khẩu cũ. Nút "Gửi mail thử" dùng cấu hình ĐÃ LƯU nên phải Lưu trước khi thử.
 */
export function SmtpSettingsPanel({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<SmtpState | null>(null);
  const [pass, setPass] = useState('');
  const [testTo, setTestTo] = useState(me.email ?? '');
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const headers = {
    'Content-Type': 'application/json',
    ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
  };

  const load = useCallback(async () => {
    setLoadErr(false);
    try {
      const res = await fetch('/api/admin/config/smtp');
      if (!res.ok) {
        setLoadErr(true);
        return;
      }
      const s = (await res.json()) as SmtpState;
      // Mặc định gợi ý Gmail khi chưa cấu hình.
      setCfg({ ...s, host: s.host || 'smtp.gmail.com', port: s.port || 587 });
    } catch {
      setLoadErr(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof SmtpState>(k: K, v: SmtpState[K]) =>
    setCfg((c) => (c ? { ...c, [k]: v } : c));

  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        user: cfg.user,
        from: cfg.from,
      };
      if (pass) body.pass = pass; // chỉ gửi khi đổi
      const res = await fetch('/api/admin/config/smtp', {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const s = (await res.json()) as SmtpState;
        setCfg({ ...s, host: s.host || 'smtp.gmail.com', port: s.port || 587 });
        setPass('');
        setMsg({ ok: true, text: t('smtp.saved', 'Đã lưu cấu hình SMTP.') });
      } else {
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        setMsg({ ok: false, text: b.message ?? t('config.saveFailed') });
      }
    } catch {
      setMsg({ ok: false, text: t('app.serverUnreachable') });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/config/smtp/test', {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const b = (await res.json()) as { ok: boolean; error?: string };
      setMsg(
        b.ok
          ? { ok: true, text: t('smtp.testSent', 'Đã gửi email thử tới {{to}}.', { to: testTo.trim() }) }
          : { ok: false, text: `${t('smtp.testFailed', 'Gửi thử thất bại')}: ${b.error ?? ''}` },
      );
    } catch {
      setMsg({ ok: false, text: t('app.serverUnreachable') });
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) {
    return (
      <div className="form-section">
        <div className="form-section-title">{t('smtp.title', 'Email (SMTP)')}</div>
        {loadErr ? (
          <p className="alert error">{t('config.loadFailed', 'Không tải được cấu hình.')}</p>
        ) : (
          <p className="muted">…</p>
        )}
      </div>
    );
  }

  return (
    <div className="form-section">
      <div className="form-section-title">{t('smtp.title', 'Email (SMTP)')}</div>
      <p className="muted" style={{ marginBottom: '0.75rem', fontSize: '0.85rem' }}>
        {t('smtp.gmailHint', 'Gmail: host smtp.gmail.com, port 587. Mật khẩu là App Password 16 ký tự (bật 2 lớp bảo mật), KHÔNG phải mật khẩu đăng nhập.')}
      </p>

      {!cfg.hasEncKey && (
        <p className="alert warn">
          {t('smtp.noEncKey', 'MAIL_ENC_KEY chưa cấu hình trên server — không lưu được mật khẩu.')}
        </p>
      )}
      {msg && <p className={`alert ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}

      <div className="form-grid">
        <label className="field span-2">
          <span>{t('smtp.host', 'SMTP host')}</span>
          <input value={cfg.host} onChange={(e) => set('host', e.target.value)} />
        </label>
        <label className="field narrow">
          <span>{t('smtp.port', 'Port')}</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={String(cfg.port)}
            onChange={(e) => set('port', Number(e.target.value) || 587)}
          />
        </label>
        <label className="field narrow" style={{ alignSelf: 'end' }}>
          <span>
            <input
              type="checkbox"
              checked={cfg.secure}
              onChange={(e) => set('secure', e.target.checked)}
              style={{ width: 'auto', marginRight: 6 }}
            />
            {t('smtp.secure', 'SSL (port 465)')}
          </span>
        </label>
        <label className="field span-2">
          <span>{t('smtp.user', 'Tài khoản (email Gmail)')}</span>
          <input
            autoComplete="off"
            value={cfg.user}
            onChange={(e) => set('user', e.target.value)}
          />
        </label>
        <label className="field span-2">
          <span>{t('smtp.from', 'Gửi từ (From) — để trống = dùng tài khoản')}</span>
          <input value={cfg.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="field span-2">
          <span>{t('smtp.pass', 'App Password')}</span>
          <input
            type="password"
            autoComplete="new-password"
            disabled={!cfg.hasEncKey}
            placeholder={
              !cfg.hasEncKey
                ? t('smtp.noEncKey', 'MAIL_ENC_KEY chưa cấu hình trên server — không lưu được mật khẩu.')
                : cfg.configured
                  ? t('smtp.passKeep', '•••••• (đã lưu — để trống nếu không đổi)')
                  : t('smtp.passNew', 'Nhập App Password Gmail')
            }
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </label>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {t('config.save', 'Lưu')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'end', flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: 1, minWidth: 220 }}>
          <span>{t('smtp.testTo', 'Gửi mail thử tới')}</span>
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || !cfg.configured || !testTo.trim()}
          onClick={() => void sendTest()}
        >
          {t('smtp.sendTest', 'Gửi mail thử')}
        </button>
      </div>
    </div>
  );
}

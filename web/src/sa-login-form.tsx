import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Form đăng nhập SA cục bộ (break-glass, story 10.1) — ẩn dưới link nhỏ ở màn login.
 * SA ít dùng (chỉ can thiệp/bootstrap); Admin SSO lo hằng ngày. Thành công → reload
 * để App nạp lại /me với quyền `sa`.
 */
export function SaLoginForm() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sa-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = '/';
        return;
      }
      if (res.status === 429) {
        setError(t('app.saLoginLocked'));
      } else if (res.status === 401) {
        setError(t('app.saLoginInvalid'));
      } else {
        setError(t('app.saLoginError'));
      }
    } catch {
      setError(t('app.saLoginError'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="ghost sm"
        onClick={() => setOpen(true)}
      >
        {t('app.saLoginLink')}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
        maxWidth: 280,
      }}
    >
      <p className="muted" style={{ margin: 0, fontWeight: 600 }}>
        {t('app.saLoginTitle')}
      </p>
      {error && (
        <p className="alert error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <input
        type="text"
        autoComplete="username"
        placeholder={t('app.saUsername')}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
      />
      <input
        type="password"
        autoComplete="current-password"
        placeholder={t('app.saPassword')}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="primary" disabled={busy}>
          {t('app.saLoginSubmit')}
        </button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          {t('app.cancel')}
        </button>
      </div>
    </form>
  );
}

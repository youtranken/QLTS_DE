import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSwitch, ThemeSwitch } from './switches';

/** Nhận dạng email tối thiểu — quyết định rẽ nhánh SSO (email) vs SA cục bộ (còn lại). */
function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Màn đăng nhập (chưa có phiên) — 1 ô nhập duy nhất. Email → chuyển PMH ID (kèm login_hint
 * để điền sẵn; đã có phiên IdP thì vào thẳng). KHÔNG phải email → hiện ô mật khẩu và thử
 * SA cục bộ (break-glass): BE trả lỗi CHUNG cho sai-tên/sai-mật-khẩu nên không lộ tồn tại
 * tài khoản SA. loginForbidden = bị chặn group (10.2) → lối thoát duy nhất là đổi tài khoản.
 */
export function LoginScreen({
  loginFailed,
  loginForbidden,
  onSwitchAccount,
}: {
  loginFailed: boolean;
  loginForbidden: boolean;
  onSwitchAccount: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'id' | 'secret'>('id');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Bước 1: email → SSO PMH ID (login_hint); còn lại → bước nhập mật khẩu (SA cục bộ).
  const submitId = (e: React.FormEvent) => {
    e.preventDefault();
    const id = identifier.trim();
    if (!id) return;
    if (isEmail(id)) {
      window.location.href = `/api/auth/login?login_hint=${encodeURIComponent(id)}`;
      return;
    }
    setError(null);
    setMode('secret');
  };

  // Bước 2: thử SA cục bộ. Nhãn trung tính (không ghi "SA") để không quảng cáo tài khoản này.
  const submitSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sa-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: identifier.trim(), password }),
      });
      if (res.ok) {
        window.location.href = '/';
        return;
      }
      if (res.status === 429) setError(t('app.saLoginLocked'));
      else if (res.status === 401) setError(t('app.saLoginInvalid'));
      else setError(t('app.saLoginError'));
    } catch {
      setError(t('app.saLoginError'));
    } finally {
      setBusy(false);
    }
  };

  const backToId = () => {
    setMode('id');
    setPassword('');
    setError(null);
  };

  return (
    <div className="auth">
      <aside className="auth-hero">
        <div className="auth-logo">
          <span className="brand-mark">QL</span>
          <div>
            <div className="auth-name">{t('app.title')}</div>
            <div className="auth-sub">{t('app.loginSub')}</div>
          </div>
        </div>
        <p className="auth-slogan">{t('app.loginSlogan')}</p>
        <ul className="auth-perks">
          <li className="auth-perk">✓ {t('app.loginPerk1')}</li>
          <li className="auth-perk">✓ {t('app.loginPerk2')}</li>
        </ul>
      </aside>
      <div className="auth-panel">
        <div className="auth-card">
          {loginFailed && (
            <p className="alert error" style={{ margin: 0 }}>
              {t('app.loginFailed')}
            </p>
          )}
          {loginForbidden ? (
            // Bị chặn (bị xóa/gỡ group): bấm login thường sẽ silent re-auth ra access_denied
            // → lặp. Lối thoát DUY NHẤT là đổi tài khoản (kết thúc phiên SSO).
            <>
              <p className="alert error" style={{ margin: 0 }}>
                {t('app.loginForbidden')}
              </p>
              <button type="button" className="primary" onClick={onSwitchAccount}>
                {t('app.loginOtherAccount')}
              </button>
            </>
          ) : mode === 'id' ? (
            <form onSubmit={submitId}>
              <h1>{t('app.loginHeading')}</h1>
              <p className="muted" style={{ margin: '0 0 4px' }}>
                {t('app.loginPrompt')}
              </p>
              {error && (
                <p className="alert error" style={{ margin: 0 }}>
                  {error}
                </p>
              )}
              <input
                type="text"
                autoComplete="username"
                autoFocus
                placeholder={t('app.loginIdPlaceholder')}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                style={{ width: '100%' }}
              />
              <button type="submit" className="primary" style={{ width: '100%' }}>
                {t('app.loginContinue')}
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => void submitSecret(e)}>
              <h1>{t('app.loginHeading')}</h1>
              <button
                type="button"
                className="ghost sm"
                onClick={backToId}
                style={{ margin: '0 0 4px' }}
              >
                ← {identifier.trim()}
              </button>
              {error && (
                <p className="alert error" style={{ margin: 0 }}>
                  {error}
                </p>
              )}
              <div className="pw-field">
                <input
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  autoFocus
                  placeholder={t('app.saPassword')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="pw-eye"
                  aria-label={showPw ? t('app.pwHide') : t('app.pwShow')}
                  aria-pressed={showPw}
                  onClick={() => setShowPw((v) => !v)}
                >
                  {showPw ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
              <button
                type="submit"
                className="primary"
                disabled={busy}
                style={{ width: '100%' }}
              >
                {t('app.saLoginSubmit')}
              </button>
            </form>
          )}
          <div className="auth-switches">
            <ThemeSwitch />
            <LanguageSwitch />
          </div>
        </div>
      </div>
    </div>
  );
}

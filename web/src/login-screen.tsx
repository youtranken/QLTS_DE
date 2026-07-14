import { useTranslation } from 'react-i18next';
import { SaLoginForm } from './sa-login-form';
import { LanguageSwitch, ThemeSwitch } from './switches';

/**
 * Màn đăng nhập (chưa có phiên) — 2 cột branded: hero + card. loginForbidden = bị chặn group
 * (10.2): lối thoát DUY NHẤT là đổi tài khoản (silent re-auth sẽ lặp access_denied).
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
            // Bị chặn (bị xóa/gỡ group): bấm "Đăng nhập" thường sẽ silent re-auth ra đúng
            // access_denied → lặp. Lối thoát DUY NHẤT là đổi tài khoản (kết thúc phiên SSO).
            <>
              <p className="alert error" style={{ margin: 0 }}>
                {t('app.loginForbidden')}
              </p>
              <button type="button" className="primary" onClick={onSwitchAccount}>
                {t('app.loginOtherAccount')}
              </button>
            </>
          ) : (
            <>
              <h1>{t('app.loginHeading')}</h1>
              <p className="muted" style={{ margin: 0 }}>
                {t('app.loginPrompt')}
              </p>
              <a href="/api/auth/login">
                <button type="button" className="primary" style={{ width: '100%' }}>
                  {t('app.login')}
                </button>
              </a>
            </>
          )}
          <SaLoginForm />
          <div className="auth-switches">
            <ThemeSwitch />
            <LanguageSwitch />
          </div>
        </div>
      </div>
    </div>
  );
}

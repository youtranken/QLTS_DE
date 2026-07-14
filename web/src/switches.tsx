import { useState } from 'react';
import { savedLanguage, setLanguage } from './i18n';
import { currentTheme, toggleTheme } from './theme';

/** Nút đổi ngôn ngữ VI/EN — dùng ở topbar và màn đăng nhập. */
export function LanguageSwitch() {
  const [lang, setLang] = useState(savedLanguage());
  const toggle = () => {
    const next = lang === 'vi' ? 'en' : 'vi';
    setLanguage(next);
    setLang(next);
  };
  return (
    <button type="button" className="ghost sm" onClick={toggle}>
      {lang === 'vi' ? 'EN' : 'VI'}
    </button>
  );
}

/** Nút đổi giao diện sáng/tối. */
export function ThemeSwitch() {
  const [theme, setThemeState] = useState(currentTheme());
  return (
    <button
      type="button"
      className="ghost sm"
      onClick={() => setThemeState(toggleTheme())}
      title={theme === 'dark' ? 'Chế độ sáng' : 'Chế độ tối'}
      aria-label={theme === 'dark' ? 'Chế độ sáng' : 'Chế độ tối'}
    >
      {theme === 'dark' ? '☀' : '🌙'}
    </button>
  );
}

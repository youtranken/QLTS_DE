const THEME_KEY = 'qlts_theme'; // chỉ theme — KHÔNG token (AD-8)

export type Theme = 'light' | 'dark';

/** Theme đang áp (đọc từ <html data-theme> mà index.html đã set sớm chống chớp). */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage bị chặn thì vẫn đổi theme phiên hiện tại
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

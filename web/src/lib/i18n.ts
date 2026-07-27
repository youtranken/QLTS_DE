import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import vi from '@/locales/vi';
import en from '@/locales/en';

const LANG_KEY = 'qlts_lang'; // chỉ lưu ngôn ngữ — KHÔNG token (AD-8)

export function savedLanguage(): 'vi' | 'en' {
  // storage bị chặn (private mode/policy) không được làm trắng trang
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'vi';
  } catch {
    return 'vi';
  }
}

/** Đồng bộ lang cho screen reader + title tab theo ngôn ngữ. */
function applyDocumentLanguage(lang: 'vi' | 'en'): void {
  document.documentElement.lang = lang;
  document.title = (i18n.t as (k: string) => string)('app.title');
}

export function setLanguage(lang: 'vi' | 'en'): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // không lưu được thì vẫn đổi ngôn ngữ phiên hiện tại
  }
  void i18n.changeLanguage(lang).then(() => applyDocumentLanguage(lang));
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      vi: { translation: vi },
      en: { translation: en },
    },
    lng: savedLanguage(),
    fallbackLng: 'vi',
    interpolation: { escapeValue: false },
  })
  .then(() => applyDocumentLanguage(savedLanguage()));

export default i18n;

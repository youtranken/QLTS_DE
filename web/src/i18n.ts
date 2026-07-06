import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import vi from './locales/vi';
import en from './locales/en';

const LANG_KEY = 'qlts_lang'; // chỉ lưu ngôn ngữ — KHÔNG token (AD-8)

export function savedLanguage(): 'vi' | 'en' {
  return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'vi';
}

export function setLanguage(lang: 'vi' | 'en'): void {
  localStorage.setItem(LANG_KEY, lang);
  void i18n.changeLanguage(lang);
}

void i18n.use(initReactI18next).init({
  resources: {
    vi: { translation: vi },
    en: { translation: en },
  },
  lng: savedLanguage(),
  fallbackLng: 'vi',
  interpolation: { escapeValue: false },
});

export default i18n;

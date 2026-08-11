/**
 * i18n configuration with per-language/per-namespace lazy loading.
 */
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { languages } from './languages.js';

const translationLoaders = import.meta.glob('./locales/*/*.json');

const translationBackend = {
  type: 'backend',
  read(language, namespace, callback) {
    const loader = translationLoaders[`./locales/${language}/${namespace}.json`];
    if (!loader) {
      callback(new Error(`Translation namespace not found: ${language}/${namespace}`), false);
      return;
    }
    loader()
      .then((module) => callback(null, module.default ?? module))
      .catch((error) => callback(error, false));
  },
};

// First run (no saved preference): follow the system locale when we support
// it, so non-Chinese users don't land in a language they can't read. An
// explicit user choice always wins, and unmatched locales keep the zh-CN
// default. (Absorbed from cc-switch's first-run locale fix.)
const getSystemLanguage = () => {
  try {
    const locale = String(navigator.language || '');
    if (!locale) return null;
    const exact = languages.find((language) => language.value.toLowerCase() === locale.toLowerCase());
    if (exact) return exact.value;
    const base = locale.split('-')[0].toLowerCase();
    if (base === 'zh') return locale.toLowerCase().includes('tw') || locale.toLowerCase().includes('hk') ? 'zh-TW' : 'zh-CN';
    const byBase = languages.find((language) => language.value.split('-')[0].toLowerCase() === base);
    return byBase ? byBase.value : null;
  } catch {
    return null;
  }
};

const getSavedLanguage = () => {
  try {
    const saved = localStorage.getItem('userLanguage');
    if (saved && languages.some((language) => language.value === saved)) return saved;
    return getSystemLanguage() || 'zh-CN';
  } catch {
    return 'zh-CN';
  }
};

void i18n
  .use(translationBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    lng: getSavedLanguage(),
    fallbackLng: 'zh-CN',
    debug: false,
    ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks'],
    defaultNS: 'common',
    keySeparator: '.',
    nsSeparator: ':',
    saveMissing: false,
    interpolation: { escapeValue: false },
    react: {
      useSuspense: true,
      bindI18n: 'languageChanged',
      bindI18nStore: false,
    },
    detection: {
      order: ['localStorage'],
      lookupLocalStorage: 'userLanguage',
      caches: ['localStorage'],
    },
  });

i18n.on('languageChanged', (language) => {
  try {
    localStorage.setItem('userLanguage', language);
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
});

if (typeof document !== 'undefined') {
  document.documentElement.lang = i18n.language || 'zh-CN';
}

export default i18n;

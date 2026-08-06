/** UI-supported concrete locales. */
export const SUPPORTED_LOCALES = ['zh-CN', 'en', 'ja', 'ko'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** User-facing locale preference. 'system' is resolved by the host process. */
export type LocalePreference = SupportedLocale | 'system';

export const DEFAULT_LOCALE: SupportedLocale = 'en';

function normalizeLocaleTag(raw: string | undefined | null): string | null {
  const tag = raw?.trim().replace(/_/g, '-').replace(/\..*$/, '');
  if (!tag) return null;

  try {
    return new Intl.Locale(tag).toString();
  } catch {
    return null;
  }
}

function getLanguageCode(raw: string | undefined | null): string | null {
  const tag = normalizeLocaleTag(raw);
  if (!tag) return null;

  try {
    return new Intl.Locale(tag).language.toLowerCase();
  } catch {
    return null;
  }
}

const LOCALE_BY_TAG = new Map<string, SupportedLocale>();
const UNIQUE_LOCALE_BY_LANGUAGE = new Map<string, SupportedLocale>();
const localeCountByLanguage = new Map<string, number>();

for (const locale of SUPPORTED_LOCALES) {
  const tag = normalizeLocaleTag(locale);
  const language = getLanguageCode(locale);
  if (tag) LOCALE_BY_TAG.set(tag.toLowerCase(), locale);
  if (language) {
    localeCountByLanguage.set(language, (localeCountByLanguage.get(language) ?? 0) + 1);
  }
}

for (const locale of SUPPORTED_LOCALES) {
  const language = getLanguageCode(locale);
  if (language && localeCountByLanguage.get(language) === 1) {
    UNIQUE_LOCALE_BY_LANGUAGE.set(language, locale);
  }
}

function matchSupportedLocale(raw: string | undefined | null): SupportedLocale | null {
  const tag = normalizeLocaleTag(raw);
  if (tag) {
    const exact = LOCALE_BY_TAG.get(tag.toLowerCase());
    if (exact) return exact;
  }

  const language = getLanguageCode(raw);
  return language ? UNIQUE_LOCALE_BY_LANGUAGE.get(language) ?? null : null;
}

/**
 * Map a single OS/browser locale string to an app-supported locale.
 *
 * Current product policy folds all Chinese variants into zh-CN because there is
 * no separate Traditional Chinese resource bundle yet.
 */
export function resolveSystemLocale(raw: string | undefined | null): SupportedLocale {
  return matchSupportedLocale(raw) ?? DEFAULT_LOCALE;
}

/**
 * Resolve the user's preferred system languages in priority order.
 *
 * Unlike app.getLocale() / navigator.language, Electron's
 * app.getPreferredSystemLanguages() returns the OS language preference list.
 */
export function resolvePreferredSystemLocale(
  rawLocales: readonly (string | undefined | null)[],
): SupportedLocale {
  for (const raw of rawLocales) {
    const locale = matchSupportedLocale(raw);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

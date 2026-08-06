import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export interface FontSettings {
  uiFamily: string;
  codeFamily: string;
  // UI size applies through --app-ui-font-size and opt-in --text-N tokens.
  uiSize: number;
  codeSize: number;
}

interface FontSettingsContextValue extends FontSettings {
  setUiFamily: (family: string) => void;
  setCodeFamily: (family: string) => void;
  setUiSize: (size: number) => void;
  setCodeSize: (size: number) => void;
  resetUiFamily: () => void;
  resetCodeFamily: () => void;
  resetUiSize: () => void;
  resetCodeSize: () => void;
}

const UI_FAMILY_KEY = 'font.uiFamily';
const CODE_FAMILY_KEY = 'font.codeFamily';
const UI_SIZE_KEY = 'font.uiSize';
const CODE_SIZE_KEY = 'font.codeSize';

export const DEFAULT_UI_FONT_SIZE = 14;
export const DEFAULT_CODE_FONT_SIZE = 14;
const MIN_UI_FONT_SIZE = 12;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const UI_TEXT_TOKEN_SIZES = [
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
] as const;

const FontSettingsContext = createContext<FontSettingsContextValue | undefined>(undefined);

function normalizeFamily(value: string): string {
  return value.trim();
}

export function clampFontSize(value: number, fallback = DEFAULT_CODE_FONT_SIZE): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

export function clampUiFontSize(value: number, fallback = DEFAULT_UI_FONT_SIZE): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(value)));
}

function getStoredString(key: string): string {
  try {
    return localStorage.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

function getStoredSize(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw.trim() === '') return fallback;
    return clampFontSize(Number(raw), fallback);
  } catch {
    return fallback;
  }
}

function getStoredUiSize(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw.trim() === '') return fallback;
    return clampUiFontSize(Number(raw), fallback);
  } catch {
    return fallback;
  }
}

function setOrRemoveStorage(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage may be unavailable
  }
}

function setSizeStorage(key: string, value: number, fallback: number): void {
  try {
    if (value === fallback) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, String(value));
    }
  } catch {
    // localStorage may be unavailable
  }
}

function withDefaultFallback(
  family: string,
  defaultVar: '--app-font-ui-default' | '--app-font-code-default',
): string {
  return family ? `${family}, var(${defaultVar})` : '';
}

export function getInitialFontSettings(): FontSettings {
  return {
    uiFamily: getStoredString(UI_FAMILY_KEY),
    codeFamily: getStoredString(CODE_FAMILY_KEY),
    uiSize: getStoredUiSize(UI_SIZE_KEY, DEFAULT_UI_FONT_SIZE),
    codeSize: getStoredSize(CODE_SIZE_KEY, DEFAULT_CODE_FONT_SIZE),
  };
}

export function applyFontSettings(settings: FontSettings): void {
  const root = document.documentElement;
  const uiFamily = normalizeFamily(settings.uiFamily);
  const codeFamily = normalizeFamily(settings.codeFamily);

  const uiValue = withDefaultFallback(uiFamily, '--app-font-ui-default');
  if (uiValue) {
    root.style.setProperty('--app-font-ui', uiValue);
  } else {
    root.style.removeProperty('--app-font-ui');
  }

  const codeValue = withDefaultFallback(codeFamily, '--app-font-code-default');
  if (codeValue) {
    root.style.setProperty('--app-font-code', codeValue);
  } else {
    root.style.removeProperty('--app-font-code');
  }

  root.style.setProperty('--app-code-font-size', `${clampFontSize(settings.codeSize)}px`);

  const uiSize = clampUiFontSize(settings.uiSize);
  const scale = uiSize / DEFAULT_UI_FONT_SIZE;
  root.style.setProperty('--app-ui-font-size', `${uiSize}px`);
  for (const tokenSize of UI_TEXT_TOKEN_SIZES) {
    root.style.setProperty(`--text-${tokenSize}`, `${Math.round(tokenSize * scale)}px`);
  }
}

export function FontSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<FontSettings>(getInitialFontSettings);

  useEffect(() => {
    applyFontSettings(settings);
  }, [settings]);

  const setUiFamily = useCallback((family: string) => {
    const next = normalizeFamily(family);
    setOrRemoveStorage(UI_FAMILY_KEY, next);
    setSettings((prev) => ({ ...prev, uiFamily: next }));
  }, []);

  const setCodeFamily = useCallback((family: string) => {
    const next = normalizeFamily(family);
    setOrRemoveStorage(CODE_FAMILY_KEY, next);
    setSettings((prev) => ({ ...prev, codeFamily: next }));
  }, []);

  const setUiSize = useCallback((size: number) => {
    const next = clampUiFontSize(size, DEFAULT_UI_FONT_SIZE);
    setSizeStorage(UI_SIZE_KEY, next, DEFAULT_UI_FONT_SIZE);
    setSettings((prev) => ({ ...prev, uiSize: next }));
  }, []);

  const setCodeSize = useCallback((size: number) => {
    const next = clampFontSize(size, DEFAULT_CODE_FONT_SIZE);
    setSizeStorage(CODE_SIZE_KEY, next, DEFAULT_CODE_FONT_SIZE);
    setSettings((prev) => ({ ...prev, codeSize: next }));
  }, []);

  const resetUiFamily = useCallback(() => setUiFamily(''), [setUiFamily]);
  const resetCodeFamily = useCallback(() => setCodeFamily(''), [setCodeFamily]);
  const resetUiSize = useCallback(() => setUiSize(DEFAULT_UI_FONT_SIZE), [setUiSize]);
  const resetCodeSize = useCallback(() => setCodeSize(DEFAULT_CODE_FONT_SIZE), [setCodeSize]);

  const value = useMemo<FontSettingsContextValue>(
    () => ({
      ...settings,
      setUiFamily,
      setCodeFamily,
      setUiSize,
      setCodeSize,
      resetUiFamily,
      resetCodeFamily,
      resetUiSize,
      resetCodeSize,
    }),
    [
      resetCodeFamily,
      resetCodeSize,
      resetUiFamily,
      resetUiSize,
      setCodeFamily,
      setCodeSize,
      setUiFamily,
      setUiSize,
      settings,
    ],
  );

  return createElement(FontSettingsContext.Provider, { value }, children);
}

export function useFontSettings(): FontSettingsContextValue {
  const context = useContext(FontSettingsContext);
  if (context === undefined) {
    throw new Error('useFontSettings must be used within a FontSettingsProvider');
  }
  return context;
}

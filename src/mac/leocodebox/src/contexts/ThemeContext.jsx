import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext();
const THEME_MODES = new Set(['system', 'light', 'dark']);

function readInitialThemeMode() {
  const savedMode = localStorage.getItem('themeMode');
  if (THEME_MODES.has(savedMode)) return savedMode;

  const legacyTheme = localStorage.getItem('theme');
  if (legacyTheme === 'light' || legacyTheme === 'dark') return legacyTheme;
  return 'system';
}

function getSystemDarkMode() {
  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};

export const ThemeProvider = ({ children }) => {
  const [themeMode, setThemeModeState] = useState(readInitialThemeMode);
  const [systemDarkMode, setSystemDarkMode] = useState(getSystemDarkMode);
  const isDarkMode = themeMode === 'system' ? systemDarkMode : themeMode === 'dark';

  useEffect(() => {
    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mediaQuery) return undefined;

    const handleSystemThemeChange = (event) => setSystemDarkMode(event.matches);
    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
  }, []);

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key === 'themeMode' && THEME_MODES.has(event.newValue)) {
        setThemeModeState(event.newValue);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('themeMode', themeMode);
    // Keep the resolved value for existing integrations and the Leoapi view.
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');

    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    statusBarMeta?.setAttribute('content', isDarkMode ? 'black-translucent' : 'default');
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    themeColorMeta?.setAttribute('content', isDarkMode ? '#111316' : '#f8f9fa');
    void window.leocodeboxDesktopTools?.setThemeMode(themeMode).catch(() => {});
  }, [isDarkMode, themeMode]);

  const setThemeMode = useCallback((nextMode) => {
    if (THEME_MODES.has(nextMode)) setThemeModeState(nextMode);
  }, []);

  const toggleDarkMode = useCallback(() => {
    setThemeModeState(isDarkMode ? 'light' : 'dark');
  }, [isDarkMode]);

  const contextValue = useMemo(() => ({ isDarkMode, themeMode, setThemeMode, toggleDarkMode }), [
    isDarkMode, themeMode, setThemeMode, toggleDarkMode,
  ]);

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
};

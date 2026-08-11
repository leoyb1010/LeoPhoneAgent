import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import i18n from '../i18n/config.js';
import type { LLMProvider } from '../types/app';
import { apiRequest } from '../utils/apiClient';

export type AppPreferences = {
  language: string;
  defaultProvider: LLMProvider;
  defaultModel: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';
  density: 'compact' | 'comfortable';
  accent: 'blue' | 'green' | 'amber';
  reduceMotion: boolean;
};

const DEFAULTS: AppPreferences = {
  language: 'zh-CN',
  defaultProvider: 'codex',
  defaultModel: '',
  permissionMode: 'default',
  density: 'compact',
  accent: 'blue',
  reduceMotion: false,
};

type PreferencesContextValue = {
  preferences: AppPreferences;
  loading: boolean;
  saving: boolean;
  updatePreferences: (updates: Partial<AppPreferences>) => Promise<void>;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function applyPreferences(preferences: AppPreferences) {
  document.documentElement.dataset.density = preferences.density;
  document.documentElement.dataset.accent = 'brand';
  document.documentElement.dataset.reduceMotion = String(preferences.reduceMotion);
  localStorage.setItem('selected-provider', preferences.defaultProvider);
  localStorage.setItem('permission-mode', preferences.permissionMode);
  localStorage.setItem('userLanguage', preferences.language);
  if (preferences.defaultModel) {
    localStorage.setItem(`${preferences.defaultProvider}-model`, preferences.defaultModel);
  }
  if (i18n.language !== preferences.language) void i18n.changeLanguage(preferences.language);
  window.dispatchEvent(new CustomEvent('leocodebox-preferences:changed', { detail: preferences }));
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    apiRequest('/api/settings/preferences')
      .then((payload) => {
        const next = { ...DEFAULTS, ...(payload.preferences || {}) } as AppPreferences;
        if (active) {
          setPreferences(next);
          applyPreferences(next);
        }
      })
      .catch((error) => console.warn('[Preferences] Using local defaults:', error))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const updatePreferences = useCallback(async (updates: Partial<AppPreferences>) => {
    setSaving(true);
    try {
      const payload = await apiRequest('/api/settings/preferences', {
        method: 'PUT',
        body: JSON.stringify(updates),
      });
      const next = { ...DEFAULTS, ...(payload.preferences || {}) } as AppPreferences;
      setPreferences(next);
      applyPreferences(next);
    } finally {
      setSaving(false);
    }
  }, []);

  const value = useMemo(
    () => ({ preferences, loading, saving, updatePreferences }),
    [loading, preferences, saving, updatePreferences],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function useAppPreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('useAppPreferences must be used within PreferencesProvider');
  return context;
}

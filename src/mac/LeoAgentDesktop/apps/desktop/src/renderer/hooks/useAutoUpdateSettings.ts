import { useCallback, useEffect, useState } from 'react';

export interface AutoUpdateSettingsState {
  autoRelaunchOnIdle: boolean;
  isCustomized: boolean;
  defaultAutoRelaunchOnIdle: boolean;
  loading: boolean;
}

const INITIAL: AutoUpdateSettingsState = {
  autoRelaunchOnIdle: false,
  isCustomized: false,
  defaultAutoRelaunchOnIdle: false,
  loading: true,
};

function normalize(payload: AutoUpdateSettingsPayload): AutoUpdateSettingsState {
  return {
    autoRelaunchOnIdle: payload.autoRelaunchOnIdle === true,
    isCustomized: payload.isCustomized === true,
    defaultAutoRelaunchOnIdle: payload.defaultAutoRelaunchOnIdle === true,
    loading: false,
  };
}

export function useAutoUpdateSettings(): {
  state: AutoUpdateSettingsState;
  setAutoRelaunchOnIdle: (enabled: boolean) => Promise<void>;
  reset: () => Promise<void>;
} {
  const [state, setState] = useState<AutoUpdateSettingsState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.getAutoUpdateSettings()
      .then((payload) => {
        if (!cancelled) setState(normalize(payload));
      })
      .catch(() => {
        if (!cancelled) setState((current) => ({ ...current, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setAutoRelaunchOnIdle = useCallback(async (enabled: boolean) => {
    const payload = await window.electronAPI.setAutoUpdateSettings({
      autoRelaunchOnIdle: enabled,
    });
    setState(normalize(payload));
  }, []);

  const reset = useCallback(async () => {
    const payload = await window.electronAPI.resetAutoUpdateSettings();
    setState(normalize(payload));
  }, []);

  return { state, setAutoRelaunchOnIdle, reset };
}

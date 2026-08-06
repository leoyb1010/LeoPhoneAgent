import { useCallback, useEffect, useState } from 'react';

import {
  getSilentEncryptedRetryEnabled,
  setSilentEncryptedRetryEnabled,
  subscribeSilentEncryptedRetryEnabled,
} from '@/lib/silentEncryptedRetryStore';

export function useSilentEncryptedRetry(): {
  enabled: boolean;
  isCustomized: boolean;
  setEnabled: (next: boolean) => void;
  setIsCustomized: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getSilentEncryptedRetryEnabled);
  const [isCustomized, setIsCustomized] = useState(false);

  const setEnabled = useCallback((next: boolean) => {
    setSilentEncryptedRetryEnabled(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker.silentEncryptedRetryGet()
      .then((settings) => {
        if (cancelled) return;
        setSilentEncryptedRetryEnabled(settings.enabled);
        setEnabledState(settings.enabled);
        setIsCustomized(Boolean(settings.isCustomized));
      })
      .catch(() => undefined);
    const unsubscribe = subscribeSilentEncryptedRetryEnabled(setEnabledState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { enabled, isCustomized, setEnabled, setIsCustomized };
}

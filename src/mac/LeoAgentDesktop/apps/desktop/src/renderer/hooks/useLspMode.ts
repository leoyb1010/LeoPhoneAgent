/**
 * useLspMode — React 包装, 订阅 lspModeStore 的变化。
 *
 * 真正 storage 在 lib/lspModeStore.ts, 本 hook 只接入 React 状态。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  getLspModeEnabled,
  setLspModeEnabled,
  subscribeLspModeEnabled,
} from '@/lib/lspModeStore';

export function useLspMode(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getLspModeEnabled);

  const setEnabled = useCallback((next: boolean) => {
    setLspModeEnabled(next);
  }, []);

  useEffect(() => subscribeLspModeEnabled(setEnabledState), []);

  return { enabled, setEnabled };
}

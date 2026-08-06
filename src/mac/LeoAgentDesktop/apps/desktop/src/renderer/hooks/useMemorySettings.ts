/**
 * useMemorySettings — React 包装, 订阅 memorySettingsStore 的变化。
 *
 * 真正的 storage 实现在 lib/memorySettingsStore.ts, 本 hook 只负责接入 React 状态。
 * 非 React 路径 (ChatInput 启 session 时透传) 应直接用 store 的 getMakerMemoryEnabled()。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  getMakerMemoryEnabled,
  setMakerMemoryEnabled,
  subscribeMakerMemoryEnabled,
} from '@/lib/memorySettingsStore';

export function useMemorySettings(): {
  makerEnabled: boolean;
  setMakerEnabled: (next: boolean) => void;
} {
  const [makerEnabled, setEnabledState] = useState<boolean>(getMakerMemoryEnabled);

  const setMakerEnabled = useCallback((next: boolean) => {
    setMakerMemoryEnabled(next);
  }, []);

  useEffect(() => subscribeMakerMemoryEnabled(setEnabledState), []);

  return { makerEnabled, setMakerEnabled };
}

import { useEffect, useState } from 'react';

import {
  hydrateCanaryChannel,
  isCanaryChannel,
  subscribeCanaryChannel,
} from './canaryChannelStore';

export interface CanaryChannelGateState {
  ready: boolean;
  isCanary: boolean;
}

/** 在所有自建更新请求之前恢复本地 canary 快照。 */
export function useCanaryChannelGate(enabled = true): CanaryChannelGateState {
  const [state, setState] = useState<CanaryChannelGateState>(() => (
    enabled ? { ready: false, isCanary: false } : { ready: true, isCanary: false }
  ));

  useEffect(() => {
    if (!enabled) {
      setState({ ready: true, isCanary: false });
      return undefined;
    }
    let cancelled = false;
    let hydrated = false;
    const syncFromStore = () => {
      if (!cancelled && hydrated) {
        setState({ ready: true, isCanary: isCanaryChannel() });
      }
    };
    const unsubscribe = subscribeCanaryChannel(syncFromStore);
    void hydrateCanaryChannel().then((isCanary) => {
      hydrated = true;
      if (!cancelled) setState({ ready: true, isCanary });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  return state;
}

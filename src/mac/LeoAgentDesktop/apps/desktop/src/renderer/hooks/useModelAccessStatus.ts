import { useEffect, useState } from 'react';

import type { ModelAccessStatus } from '../../shared/modelAccess';

const IDLE: ModelAccessStatus = { state: 'idle', source: null, endpoint: null };

/**
 * useModelAccessStatus —— 网关凭据自动下发的同步状态(main 侧权威,推送驱动)。
 *
 * mount 时拉一次快照(避免错过挂载前的推送),此后订阅
 * MODEL_ACCESS_STATUS_CHANNEL 增量更新。状态语义见 shared/modelAccess.ts。
 */
export function useModelAccessStatus(): ModelAccessStatus {
  const [status, setStatus] = useState<ModelAccessStatus>(IDLE);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.modelAccess
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    const unsubscribe = window.electronAPI.modelAccess.onStatusChange((s) => setStatus(s));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return status;
}

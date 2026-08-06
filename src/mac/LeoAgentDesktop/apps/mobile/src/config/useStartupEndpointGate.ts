// 启动端点清单闸门 hook:冷启动时跑 runStartupEndpointResolve,成功前业务树
// 不挂载。正式包只认 CDN 清单:字段缺失/空白允许放行;拉取失败、JSON/schema
// 无法解析或非空值非法时进入 error 态,由 _layout 渲染错误屏,用户点重试再跑一次;
// 无包内回退。
// __DEV__ 默认放行(零网络,端点初值来自仓内 config/endpoint.json,见 env.ts);
// EXPO_PUBLIC_ENDPOINTS_CDN=1 时 dev 也走完整 CDN 闸门(测线上清单,与
// desktop 的 --endpoints-cdn 同语义)。
// 时序:本闸门必须先于 OTA 检查更新(_layout 只在 ready 后挂载 OTA 门)。

import { useCallback, useEffect, useRef, useState } from 'react';

import { isTestFlightBuild } from '@/platform/appDistribution';
import { runStartupEndpointResolve } from './clientEndpointStartup';
import { resolveEnvFlag } from './env';

export type StartupEndpointGateStatus = 'pending' | 'ready' | 'error';

export interface StartupEndpointGate {
  status: StartupEndpointGateStatus;
  /** status === 'error' 时的失败原因(fetch-failed / invalid-json / ...)。 */
  reason: string | null;
  /** 错误屏「重试」:回到 pending 并重新拉取。 */
  retry: () => void;
}

export function useStartupEndpointGate(): StartupEndpointGate {
  const enabled = !__DEV__ || resolveEnvFlag(process.env.EXPO_PUBLIC_ENDPOINTS_CDN);
  const [status, setStatus] = useState<StartupEndpointGateStatus>(enabled ? 'pending' : 'ready');
  const [reason, setReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);

  useEffect(() => {
    if (!enabled || status === 'ready' || running.current) return;
    if (status === 'error') return; // 等用户点重试
    running.current = true;
    let cancelled = false;
    void runStartupEndpointResolve({ resolveIsTestFlight: isTestFlightBuild }).then((outcome) => {
      running.current = false;
      if (cancelled) return;
      if (outcome.ok) {
        setStatus('ready');
      } else {
        setReason(outcome.reason);
        setStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, status, attempt]);

  const retry = useCallback(() => {
    setReason(null);
    setStatus('pending');
    setAttempt((n) => n + 1);
  }, []);

  return { status, reason, retry };
}

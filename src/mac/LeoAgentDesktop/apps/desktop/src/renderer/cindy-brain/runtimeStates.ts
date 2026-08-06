import { useSyncExternalStore } from 'react';

/**
 * 意识运行时状态的 renderer 侧只读镜像。
 *
 * 数据流:main 的 GhostRuntime 每次状态变化广播 ghosts:runtime-changed
 * (全量 states map);首帧另拉一次快照(面板可能在崩溃发生后才挂载,
 * 只靠广播会漏掉既有的 crashed/fused 态)。
 * 消费方:意识面板的错误接管态(crashed / fused 原地显示错误 + 重载/关闭)。
 * 测试/无桥环境没有 ghosts 桥:恒为空 map,所有意识视同 off。
 */

let states: Record<string, string> = {};
const listeners = new Set<() => void>();
let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  const api = window.electronAPI?.ghosts;
  if (!api?.onRuntimeChanged) return;
  api.onRuntimeChanged(({ states: next }) => {
    states = next;
    listeners.forEach((l) => l());
  });
  void api
    .runtimeStates()
    .then(({ states: next }) => {
      states = next;
      listeners.forEach((l) => l());
    })
    .catch(() => {
      /* main 未注册(理论不发生)时保持空 map */
    });
}

function subscribe(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 某段意识的运行时状态;未知/未跑 = 'off'。 */
export function useGhostRuntimeState(id: string): string {
  return useSyncExternalStore(subscribe, () => states[id] ?? 'off');
}

/** 仅测试用:重置模块状态。 */
export function __resetGhostRuntimeStatesForTest(): void {
  states = {};
  listeners.clear();
  initialized = false;
}

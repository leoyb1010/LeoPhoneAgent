import { useSyncExternalStore } from 'react';

/**
 * 模块级分钟心跳:单一 interval、惰性启停(有订阅者才计时),供相对时间标签等
 * 「随钟表走的展示」订阅。订阅组件每分钟重渲染一次,拿到新的 now 快照。
 * ---------------------------------------------------------------------------
 * 背景(2026-07-18 重渲染风暴修复的补偿):会话行 memo 化后不再逐 store emit
 * 重渲染,行内相对时间(「刚刚 / N 分钟前」)失去了此前"靠风暴保鲜"的偶然刷新,
 * 会无限期冻结(review P1)。行内订阅本 hook 后,每分钟以数据变化的方式放行一次
 * 重渲染——挂载行 ~百级 × 1 次/分钟,成本可忽略,且 hook 订阅不受 memo 阻断。
 */
let minuteNow = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const MINUTE_MS = 60_000;

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      minuteNow = Date.now();
      for (const sub of subs) sub();
    }, MINUTE_MS);
  }
  return () => {
    subs.delete(cb);
    if (timer && subs.size === 0) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, () => minuteNow);
}

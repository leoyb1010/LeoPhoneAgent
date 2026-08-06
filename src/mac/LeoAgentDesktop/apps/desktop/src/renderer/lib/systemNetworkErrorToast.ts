/**
 * systemNetworkErrorToast — main 进程 lifecycle 兜底 catch 到瞬时网络错误
 * (ETIMEDOUT/ECONNRESET/ENOTFOUND 等) 时, 给用户弹一条多语言 toast。
 *
 * 设计要点:
 * - main 已经 log [FATAL] + log.error 留全栈, 这里只负责"让用户感知到刚才网络抖了"。
 * - 节流: 同一个 err.code 60s 内只弹一次, 避免 VPN 一直断时 toast 雪崩
 *   (历史日志显示一次启动 ~14s 就会再崩一次, 不节流会刷屏)。
 * - 文案走 i18n `commonUi.systemErrorTips.transientNetwork`, code 透传给用户
 *   方便截图反馈; 不暴露 address/port (那些 IP 对用户没意义)。
 * - 用 error (红) 不用 warning: 这本质就是一次网络请求失败, 之前是直接崩 App
 *   的级别, 现在虽然兜住了不崩, 但语义仍然是 error, 用户也需要知道严重性。
 * - duration 走 error 默认时长 (lib/toast.ts), 不再单独指定。
 */

import { i18n } from '@/i18n';

import { toast } from './toast';

const THROTTLE_MS = 60_000;

/** 同一 err.code 上次弹 toast 的时间戳, 用于节流。 */
const lastShownAt = new Map<string, number>();

interface TransientNetworkErrorPayload {
  code: string;
  address?: string;
  port?: number;
}

/**
 * 收到 main 推送的瞬时网络错误事件后调用。命中节流则忽略。
 *
 * exported for testing / future direct invocation; 正常订阅路径在
 * `installSystemNetworkErrorToastListener()` 里。
 */
export function handleTransientNetworkError(payload: TransientNetworkErrorPayload): void {
  const code = payload.code || 'UNKNOWN';
  const now = Date.now();
  const last = lastShownAt.get(code);
  if (last !== undefined && now - last < THROTTLE_MS) return;
  lastShownAt.set(code, now);

  const message = i18n.t('commonUi.systemErrorTips.transientNetwork', { code });
  toast.error(message);
}

/**
 * 在 renderer 启动期挂一次 (App.tsx)。返回的 unsubscribe 供 useEffect cleanup,
 * 但实际生命周期等于 renderer 进程, 解绑只在 HMR / unmount 走。
 */
export function installSystemNetworkErrorToastListener(): () => void {
  return window.electronAPI.onSystemTransientNetworkError(handleTransientNetworkError);
}

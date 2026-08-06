/**
 * useNavigationKeyListener
 * ---------------------------------------------------------------------------
 * 在 window 上监听"翻页/方向类"按键,触发回调。
 *
 * 用途:chat 滚动悬浮 chip(prev-user-msg / chip-jump suppression)需要区分
 * "用户主动想看历史"和"smooth scroll 余波"。wheel/touch 挂在 scroll 容器
 * 上即可,但键盘焦点常常不在 scroll 容器上(尤其输入框聚焦时仍能用 PageUp /
 * 方向键滚 chat),所以必须挂 window 才捕获得到。
 *
 * 抽出来的原因:之前 MessageStream(chip-jump suppression 解抑)和
 * usePrevUserMessageInView(suppress 解除)各自挂一份相同 key 列表的 listener。
 * 重复不算 bug,但两处 key 集合若漂移会很微妙(比如有人给一边加了 Space
 * 忘了另一边)。统一用同一份 NAVIGATION_KEYS 是单一信息源。
 */

import { useEffect, useRef } from 'react';

/** 翻页/方向类按键集合 — 视为"用户主动想看历史"的信号。
 *  普通文字键(字母数字、Tab、Enter 等)不在内,避免输入框打字被误当成滚动意图。 */
export const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

/**
 * 监听 window keydown,任一 NAVIGATION_KEYS 触发时调用 onNavKey。
 * onNavKey 用 ref 持有,避免每次 render 重新挂 listener。
 */
export function useNavigationKeyListener(onNavKey: () => void): void {
  const cbRef = useRef(onNavKey);
  cbRef.current = onNavKey;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (NAVIGATION_KEYS.has(e.key)) {
        cbRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, []);
}

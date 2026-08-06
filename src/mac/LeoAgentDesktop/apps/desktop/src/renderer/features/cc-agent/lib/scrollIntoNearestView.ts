/**
 * scrollIntoNearestView — 把目标元素滚进 viewport 的统一封装
 * ---------------------------------------------------------------------------
 * 通用约定:
 *   - block: 'nearest' —— 已可见时滚动距离为 0,不触发任何动画
 *   - behavior 由 prefers-reduced-motion 决定 —— 启用减弱动画的用户拿到
 *     instant scroll;否则 smooth animation。matchMedia 同步 API,Electron
 *     renderer 永远在浏览器环境,typeof window 检查仅做 SSR-safety 兜底
 *
 * 调用方负责传 element(可能为 null,helper 内部短路)。常见来源:
 *   - useRef.current
 *   - document.querySelector('[data-session-id="..."]')
 */
export function scrollIntoNearestView(el: Element | null | undefined): void {
  if (!el) return;
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({
    block: 'nearest',
    behavior: reduceMotion ? 'auto' : 'smooth',
  });
}

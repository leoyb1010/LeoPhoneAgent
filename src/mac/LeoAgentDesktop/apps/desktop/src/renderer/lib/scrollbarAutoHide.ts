/**
 * Scrollbar auto-hide
 * ---------------------------------------------------------------------------
 * 全局给所有可滚动容器添加 `is-scrolling` 类:
 *   - 滚动事件:无条件触发
 *   - 鼠标移动:只在鼠标位于"滚动条区域"(容器右侧约 16px gutter)时触发
 *   - 最近一次触发后 2 秒移除
 *
 * 配合 globals.css 里的 `.is-scrolling::-webkit-scrollbar-thumb` 规则,
 * 实现"滚动 / hover 滚动条时显形,停手 2 秒后淡出"的体验。
 *
 * 关键约束:
 * - scroll 事件不冒泡,必须 capture 阶段在 document 上拦截。
 * - mousemove 不能在容器内任意位置 activate,否则 2s 计时器会被持续重置,
 *   永远看不到 fade-out;只有进入滚动条横向带才算。
 * - 用 WeakMap 按元素维护 timer,避免多容器共享同一计时器互相清除。
 */

const FADE_DELAY = 2000;
const ACTIVE_CLASS = 'is-scrolling';
const MOUSE_THROTTLE = 80;
/** 滚动条横向占位宽度,与 globals.css 里的 `::-webkit-scrollbar { width }` 保持一致。 */
const SCROLLBAR_ZONE_PX = 12;

const timers = new WeakMap<Element, number>();
const suppressUntil = new WeakMap<Element, number>();

function activate(el: Element): void {
  el.classList.add(ACTIVE_CLASS);
  const existing = timers.get(el);
  if (existing !== undefined) clearTimeout(existing);
  const id = window.setTimeout(() => {
    el.classList.remove(ACTIVE_CLASS);
    timers.delete(el);
  }, FADE_DELAY);
  timers.set(el, id);
}

/**
 * 主动「闪一下」滚动条 —— 仅当元素真的可纵向滚动时,加上 is-scrolling 类(2s 后自动淡出,
 * 与 scroll/hover 触发同一套淡出逻辑)。用于面板打开时提示用户「这里可以滚动」。
 * 不可滚动则 no-op。
 */
export function flashScrollbar(el: Element): void {
  if (!isVerticallyScrollable(el)) return;
  activate(el);
}

export function suppressScrollbarActivation(el: Element, durationMs = 250): void {
  suppressUntil.set(el, performance.now() + durationMs);
  el.classList.remove(ACTIVE_CLASS);
  const existing = timers.get(el);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(el);
  }
}

/** 元素自身在 Y 方向真的可以滚（overflow-y 是 auto/scroll 且 scrollHeight 超出 clientHeight）。 */
function isVerticallyScrollable(el: Element): boolean {
  const oy = getComputedStyle(el).overflowY;
  if (oy !== 'auto' && oy !== 'scroll') return false;
  return el.scrollHeight > el.clientHeight;
}

function findScrollContainer(target: EventTarget | null): Element | null {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    if (isVerticallyScrollable(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function handleScroll(e: Event): void {
  if (!(e.target instanceof Element)) return;
  const until = suppressUntil.get(e.target);
  if (until !== undefined) {
    if (performance.now() < until) return;
    suppressUntil.delete(e.target);
  }
  activate(e.target);
}

let lastMouseTime = 0;

function handleMouseMove(e: MouseEvent): void {
  const now = performance.now();
  if (now - lastMouseTime < MOUSE_THROTTLE) return;
  lastMouseTime = now;

  const container = findScrollContainer(e.target);
  if (!container) return;
  const rect = container.getBoundingClientRect();
  // 鼠标横坐标距容器右边的距离;只有 ≤ SCROLLBAR_ZONE_PX 的时候才算"在滚动条上"
  const distFromRight = rect.right - e.clientX;
  if (distFromRight < 0 || distFromRight > SCROLLBAR_ZONE_PX) return;
  activate(container);
}

let installed = false;

export function installScrollbarAutoHide(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
  document.addEventListener('mousemove', handleMouseMove, { capture: true, passive: true });
}

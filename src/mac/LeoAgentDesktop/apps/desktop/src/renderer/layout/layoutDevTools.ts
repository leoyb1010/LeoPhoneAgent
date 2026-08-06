import {
  removeRootSplitPaneByKind,
  type Layout,
  type SplitNode,
} from '../../shared/layoutTree';

/**
 * 布局树 dev 调试工具—— 证明"引擎是活的"的黑盒验证入口。
 *
 * Step A 承诺外观零变化,布局引擎的通用性(顺序真的由树驱动、持久化真的
 * round-trip)没有任何用户可见路径能验证 —— 本工具在 dev 构建下往 window 挂
 * `__cindyLayout`,QA 在 DevTools console 里调用:
 *
 *   __cindyLayout.get()                当前布局树
 *   await __cindyLayout.swap()         交换根分割 children 顺序(聊天区 ⇄ 工具面板)
 *   await __cindyLayout.reset()        重置为默认布局
 *   await __cindyLayout.removePane(k)  从树里移除指定 panelKind 的 pane(意识
 *                                      面板真装卸走 __cindyGhosts;这里只测树操作)
 *
 * 生产构建(import.meta.env.DEV = false)完全不挂载,零暴露。
 * 写路径全部走 electronAPI.layout(main 侧 LayoutStore 严格校验),本工具
 * 不绕过任何校验 —— 非法结果会被 main 拒绝,这也是验证点之一。
 */

/**
 * 纯函数:反转根分割的 children 顺序(默认树下即聊天区 ⇄ 工具面板)。
 * content 不是分割或 children 不足 2 时不可交换,返回 null。不改输入。
 */
export function makeRootSwappedLayout(layout: Layout): Layout | null {
  if (layout.content.type !== 'split' || layout.content.children.length < 2) return null;
  const next = structuredClone(layout);
  (next.content as SplitNode).children.reverse();
  return next;
}

interface LayoutDevToolsApi {
  get: () => Layout;
  swap: () => Promise<string>;
  reset: () => Promise<string>;
  /** 从树里移除指定 panelKind 的 pane(位置记忆随之丢弃)。 */
  removePane: (kind: string) => Promise<string>;
}

declare global {
  interface Window {
    /** dev-only 布局调试入口;生产构建不存在。 */
    __cindyLayout?: LayoutDevToolsApi;
  }
}

/** 挂载 dev 调试入口(幂等;仅 dev 构建生效)。由 LayoutRoot 调用。 */
export function installLayoutDevTools(): void {
  if (!import.meta.env.DEV) return;
  if (window.__cindyLayout) return;
  window.__cindyLayout = {
    get: () => window.electronAPI.layout.getStateSync().layout,
    swap: async () => {
      const current = window.electronAPI.layout.getStateSync().layout;
      const next = makeRootSwappedLayout(current);
      if (!next) return 'content 不是多子分割,无可交换';
      await window.electronAPI.layout.set(next);
      return '已交换根分割 children 顺序;界面应即时重排,重启后保持';
    },
    reset: async () => {
      await window.electronAPI.layout.reset();
      return '已重置为默认布局';
    },
    removePane: async (kind: string) => {
      const current = window.electronAPI.layout.getStateSync().layout;
      const op = removeRootSplitPaneByKind(current, kind);
      if (!op.applied) return `移除失败: ${op.reason ?? 'unknown'}`;
      await window.electronAPI.layout.set(op.layout);
      return `已从布局树移除 ${kind} 的 pane(位置记忆已丢弃)`;
    },
  };
}

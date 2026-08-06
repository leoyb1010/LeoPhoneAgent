/**
 * BrowserWebviewPool —— web-browser plugin 用的 webview 池挂载点。
 *
 * 真正的池逻辑在 `lib/browserWebviewPool.ts` 模块单例(vanilla DOM,不走 React
 * Portal —— 见模块文件大注释);这里的 React 组件只是 MainLayout 上的占位,
 * 用来:
 *
 *   1) 让 pool 在 MainLayout 第一次 mount 时就 `ensureContainer()`(模块的 lazy
 *      创建逻辑会在 acquire 时再触发,所以这里其实可以不主动 ensure 也 OK;留
 *      个占位主要是为了 Phase 6 maximize 时统一管 layout)
 *   2) 给 Phase 6 maximize 行为(主区 hide / RSB 撑满)留挂载点:maximize 状态
 *      变化时这里可以把 pool container 的 css 改成 fixed 全屏。Phase 4 范围内
 *      没行为,只是确保有这个组件实例 —— 切记 React 端不要 portal 到 pool
 *      container,所有 webview DOM 进出由 vanilla appendChild 控制。
 *
 * 组件本身渲染 nothing —— pool 的 off-screen container 由模块自己 append 到
 * document.body,React tree 上不需要任何占位。
 */
export function BrowserWebviewPool(): null {
  // 占位组件,Phase 4 范围内无副作用。Phase 5 接入 plugin 后真实使用 pool;
  // Phase 6 maximize 时这里加 layout 控制。
  return null;
}

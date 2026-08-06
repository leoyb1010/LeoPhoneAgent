/**
 * sidebarWindow —— 判断当前 renderer 是否运行在「右侧栏独立子窗口」里。
 *
 * 子窗口由 main/right-sidebar-window/window.ts 用启动参数 `?sidebarWindow=1` 打开
 * (查询参数在 hash 之前,不影响 hash router 路由),hash 固定 `/sidebar-window`。
 * renderer 据此:
 *   - router 落到 SidebarWindowLayout(只挂 RightSidebarShell,不挂 MainLayout)
 *   - WindowControls 关闭按钮走"只关本窗"语义(跳过主窗的退出确认 / closing overlay)
 *
 * 与 secondaryWindow.ts 同款:单次读取启动 URL,值在窗口生命周期内不变。
 */
export function isSidebarWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('sidebarWindow') === '1';
  } catch {
    return false;
  }
}

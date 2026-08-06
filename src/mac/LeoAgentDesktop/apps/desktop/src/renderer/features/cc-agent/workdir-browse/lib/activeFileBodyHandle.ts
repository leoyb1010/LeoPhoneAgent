/**
 * 全局 module-level singleton 持有当前 active FileBodyView 的 isDirty/save
 * 引用。
 *
 * 为什么需要这个:
 *   doc 模式下 WorkdirBrowseSidebar(文件树/搜索结果) 和 WorkdirBrowseRoute
 *   (FileBodyView 宿主) 是兄弟节点,sidebar 拿不到 FileBodyView 的 ref。
 *   sidebar 切文件前要做 dirty 检查,需要一个跨兄弟拿 handle 的通道。
 *   doc 模式下任何时候只有一个 active FileBodyView,所以单例 ref 就够,
 *   不需要 zustand / context 那种复杂状态。
 *
 * 生命周期:
 *   - FileBodyView mount 时调 setActiveFileBodyHandle(handle)。
 *   - unmount 时调 setActiveFileBodyHandle(null)。
 *   - sidebar 切文件前调 getActiveFileBodyHandle()?.isDirty()。
 *
 * 不放进 React 状态:这个 handle 在每次 ref 更新时不应触发 re-render —— 它
 * 只在用户主动操作(切文件)时被读一次,push-based 更新不需要。
 */

import type { FileBodyHandle } from '../FileBodyView';

let activeHandle: FileBodyHandle | null = null;

export function setActiveFileBodyHandle(handle: FileBodyHandle | null): void {
  activeHandle = handle;
}

export function getActiveFileBodyHandle(): FileBodyHandle | null {
  return activeHandle;
}

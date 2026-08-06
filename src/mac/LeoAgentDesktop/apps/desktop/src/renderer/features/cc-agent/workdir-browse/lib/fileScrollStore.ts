/**
 * fileScrollStore — per-file scroll anchor of doc 模式的文件 body。
 *
 * 覆盖两条渲染路径,共用同一个 store:
 *   - markdown / text 预览容器 (FileBodyView 的 overflow-y-auto wrapper)
 *   - 代码文件 / 编辑态的 CodeMirror (.cm-scroller, view.scrollDOM)
 *
 * 用途:用户在 doc 模式滚到中间 → 点编辑 / 返回 projects / 切到别的会话
 *      → 再回来同一个文件,viewport 还原到离开时的位置,而不是回到顶。
 *
 * 同时存 scrollTop、viewport 顶部块行号和块内偏移:
 *   - scrollTop:普通文本/代码布局稳定时最精确。
 *   - line + offset:Markdown live-preview / line wrapping 在 mount 后几帧内
 *     可能改变 scrollHeight。只存 line 会把视口顶强制贴到段落/表格开头,
 *     offset 保留用户停在块中间的位置。
 *
 * 仅内存(Map),session 级。应用重启或刷新页面后清零 —— 简单、零持久化负担,
 * 也避免长期堆积陈旧条目。如果未来要跨重启保留,改成 localStorage + LRU 即可。
 *
 * Key:`${workdir}\u0000${relPath}`,workdir 切换 / 同 workdir 不同文件互不污染。
 */

export interface FileScrollAnchor {
  top: number;
  line: number | null;
  offset: number | null;
}

const store = new Map<string, FileScrollAnchor>();

function makeKey(workdir: string, relPath: string): string {
  return `${workdir}\u0000${relPath}`;
}

export function loadFileScroll(workdir: string, relPath: string): FileScrollAnchor | null {
  const v = store.get(makeKey(workdir, relPath));
  return v ?? null;
}

export function saveFileScroll(
  workdir: string,
  relPath: string,
  anchor: FileScrollAnchor,
): void {
  store.set(makeKey(workdir, relPath), anchor);
}

export function clearFileScroll(workdir: string, relPath: string): void {
  store.delete(makeKey(workdir, relPath));
}

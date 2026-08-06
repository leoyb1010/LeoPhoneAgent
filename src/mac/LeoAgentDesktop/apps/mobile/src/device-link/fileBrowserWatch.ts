/**
 * 被控端文件树变更事件(maker:file-browser:event)的手机端分发。
 *
 * DeviceLinkContext 的 routeFrame 把该 channel 的 push 灌进来;文件浏览页
 * 按 workdir 过滤后做去抖静默刷新。极简 emitter:监听方自己过滤,不在这里
 * 建 workdir 索引(同时存在的浏览页数量个位数)。
 */

export interface FileBrowserWatchEvent {
  workdir: string;
  relPath?: string;
}

type Listener = (event: FileBrowserWatchEvent) => void;

const listeners = new Set<Listener>();

export function onFileBrowserWatchEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dispatchFileBrowserWatchEvent(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const workdir = (payload as { workdir?: unknown }).workdir;
  if (typeof workdir !== 'string' || !workdir) return;
  const relPath = (payload as { relPath?: unknown }).relPath;
  const event: FileBrowserWatchEvent = {
    workdir,
    relPath: typeof relPath === 'string' ? relPath : undefined,
  };
  for (const listener of listeners) listener(event);
}

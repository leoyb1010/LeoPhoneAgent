/**
 * lspModeStore — LSP Beta 开关的 renderer 端镜像。
 *
 * Source of truth: main 的 <userData>/lsp-mode-settings.json (lsp-mode-store.ts)。
 * 这里 localStorage 只是 renderer UI 即时态镜像, 完全照搬 compatModeStore 形态。
 *
 * 二态:
 *   - true  : mcp providers 注入 lsp_* 工具 (仍受 detectTypeScriptProject + workdir gate)
 *   - false : 不注入, agent 工具列表里看不到 lsp_* (默认值)
 *
 * **默认 false** —— Phase 1 Beta, admin 手动 opt-in 才生效。
 */

const STORAGE_KEY = 'lspMode.enabled';

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();

export function getLspModeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setLspModeEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // localStorage 不可用 — 忽略
  }
  subscribers.forEach((cb) => cb(next));
}

export function subscribeLspModeEnabled(cb: Subscriber): () => void {
  subscribers.add(cb);
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cb(getLspModeEnabled());
  };
  window.addEventListener('storage', storageHandler);
  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

/**
 * 启动期一次性从 main 拉真值同步到 localStorage。
 * 失败兜底: 静默, 留旧值。
 */
export async function bootstrapLspModeFromMain(): Promise<void> {
  try {
    const settings = await window.electronAPI.maker.lspModeGet();
    if (getLspModeEnabled() === settings.enabled) return;
    setLspModeEnabled(settings.enabled);
  } catch {
    // preload 未就绪 / IPC 异常 — 留旧 localStorage
  }
}

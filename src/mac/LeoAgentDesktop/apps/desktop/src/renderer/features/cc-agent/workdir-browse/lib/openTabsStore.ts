/**
 * openTabsStore — per-workdir 已打开文件 tab 列表持久化。
 *
 * 设计要点：
 *   - 单一 localStorage key，按 workdir 分桶；每桶一个 string[] (relPath 列表)
 *     表示当前 tab 顺序。
 *   - 模块级 cache + subscribe 模式：多个组件（Sidebar / Route / TabsBar）
 *     可以共享同一份 tab 状态，任意一处改动其它处实时同步。
 *   - LRU evict：workdir 数量超 100 删最早的（按 key 字母序近似 LRU，够用）。
 *   - 不限 tab 数量（受 localStorage 总容量约束，单 workdir 上限按 200 截断
 *     防御性兜底）。
 *   - 任何写入失败（quota / disabled）静默降级，内存 cache 仍然工作。
 */

const STORAGE_KEY = 'cc-agent.workdirBrowse.openTabs.v1';
const MAX_WORKDIRS = 100;
const MAX_TABS_PER_WORKDIR = 200;

type Bag = Record<string, string[]>;
type Listener = (workdir: string) => void;

const cache = new Map<string, string[]>();
const listeners = new Set<Listener>();
let bagLoaded = false;
let bagInMem: Bag = {};

function loadBag(): Bag {
  if (bagLoaded) return bagInMem;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Bag = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
            out[k] = v as string[];
          }
        }
        bagInMem = out;
      }
    }
  } catch {
    bagInMem = {};
  }
  bagLoaded = true;
  return bagInMem;
}

function saveBag(): void {
  try {
    const keys = Object.keys(bagInMem);
    if (keys.length > MAX_WORKDIRS) {
      const evict = keys.sort().slice(0, keys.length - MAX_WORKDIRS);
      for (const k of evict) delete bagInMem[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bagInMem));
  } catch {
    // localStorage 满 / 禁用 — 静默降级，内存 cache 仍工作。
  }
}

function notify(workdir: string): void {
  for (const l of listeners) l(workdir);
}

function commit(workdir: string, tabs: string[]): void {
  const capped = tabs.slice(0, MAX_TABS_PER_WORKDIR);
  cache.set(workdir, capped);
  loadBag();
  bagInMem[workdir] = capped;
  saveBag();
  notify(workdir);
}

export function getTabs(workdir: string): string[] {
  if (!workdir) return [];
  const cached = cache.get(workdir);
  if (cached) return cached;
  const bag = loadBag();
  const tabs = bag[workdir] ?? [];
  cache.set(workdir, tabs);
  return tabs;
}

/** 已存在 → no-op；不存在 → append 到末尾。返回是否真的发生了变化。 */
export function addTab(workdir: string, relPath: string): boolean {
  if (!workdir || !relPath) return false;
  const tabs = getTabs(workdir);
  if (tabs.includes(relPath)) return false;
  commit(workdir, [...tabs, relPath]);
  return true;
}

/** 不存在 → no-op。返回是否真的发生了变化。 */
export function removeTab(workdir: string, relPath: string): boolean {
  if (!workdir || !relPath) return false;
  const tabs = getTabs(workdir);
  const idx = tabs.indexOf(relPath);
  if (idx === -1) return false;
  const next = [...tabs];
  next.splice(idx, 1);
  commit(workdir, next);
  return true;
}

/**
 * 批量关闭。一次写入 + 一次 notify,避免多 tab 关闭时连续触发订阅造成
 * 中间态 (e.g. "关闭其他" 过程中先看到只剩 0 个再变 1 个)。返回真正被
 * 关掉的 tab 列表 (输入里命中 tabs 的那部分),用于 caller 清 scroll cache 等。
 */
export function closeTabs(workdir: string, paths: readonly string[]): string[] {
  if (!workdir || paths.length === 0) return [];
  const tabs = getTabs(workdir);
  if (tabs.length === 0) return [];
  const toClose = new Set(paths);
  const next = tabs.filter((p) => !toClose.has(p));
  if (next.length === tabs.length) return [];
  commit(workdir, next);
  return tabs.filter((p) => toClose.has(p));
}

/**
 * 把 fromIdx 处的 tab 移动到 toIdx。两个 idx 都在新数组里的位置；
 * 越界自动 clamp。
 */
export function reorderTabs(workdir: string, fromIdx: number, toIdx: number): void {
  if (!workdir) return;
  const tabs = getTabs(workdir);
  if (fromIdx < 0 || fromIdx >= tabs.length) return;
  const clamped = Math.max(0, Math.min(toIdx, tabs.length - 1));
  if (fromIdx === clamped) return;
  const next = [...tabs];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(clamped, 0, moved);
  commit(workdir, next);
}

/**
 * 重命名场景:把所有以 `${fromRel}` 开头的 tab 路径替换为 `${toRel}` 开头。
 * 命中条件:
 *   - 完全相等(单文件 rename) → 整个替换
 *   - 以 `${fromRel}/` 开头(folder rename, tab 在该目录子树里) → 替换前缀
 * 替换后保持在原 tab 顺序里的位置(只 swap path 字符串)。
 * 若有 tab 命中 → 真的写一次;无命中 → no-op,不触发 subscribe。
 */
export function renameTabPrefix(workdir: string, fromRel: string, toRel: string): boolean {
  if (!workdir || !fromRel || !toRel || fromRel === toRel) return false;
  const tabs = getTabs(workdir);
  let changed = false;
  const next = tabs.map((t) => {
    if (t === fromRel) {
      changed = true;
      return toRel;
    }
    const prefix = `${fromRel}/`;
    if (t.startsWith(prefix)) {
      changed = true;
      return `${toRel}/${t.slice(prefix.length)}`;
    }
    return t;
  });
  if (!changed) return false;
  commit(workdir, next);
  return true;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

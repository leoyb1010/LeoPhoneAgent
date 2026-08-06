/**
 * useSessionScopedTreeWidth — 文件浏览器 plugin 内文件树宽度的 per-session 持久化封装。
 *
 * **包装而非改造通用 hook**:`useHorizontalResize` 还服务左栏 / scheduler 两个不需要
 * per-session 语义的消费者,加 fallbackStorageKey 选项会污染通用 hook 的 API,不值。
 * 这里 sessionId / fallback 逻辑全在 wrapper 内部消化,内层只看见普通 storageKey。
 *
 * **读取链**:per-session(`rightSidebar.fileBrowser.treeWidth:${sessionId}`)
 *   → `:last` fallback(`rightSidebar.fileBrowser.treeWidth:last`)
 *   → 硬编码 `TREE_DEFAULT_WIDTH`。
 *
 * **写入**:用户任何主动动作(拖拽松手 / 命令式 setWidth / 双击 reset)都把当前 width
 * 镜像写到 `:last`。内层 `useHorizontalResize` 会把同一个值 persist 到 per-session key。
 * sessionId 切换时主动重读 storage 并 `setWidth(next)`,这一步会自动把 fallback 物化到
 * 新 session 的 per-session key —— 符合 "新 session 第一次打开继承 last 然后独立" 的语义。
 *
 * **resetWidth 特殊处理**:内层 reset 会把 default 写进 per-session key;wrapper 要紧接着
 * 把那个 per-session key 擦掉,让下次 sessionId 切换的读取链落回 `:last`(刚被刷成 default)。
 *
 * **同 session 多个 file-browser tab**:共享同一个 per-session key。打开瞬间各自 useState
 * 读取(可能读到的还是之前 tab 写的值),后续无 live-sync,但镜像写 `:last` 都到同一个 key,
 * 关闭/重开行为一致。和当前全局 key 体验一致,只是边界从"全局"缩到"session"。
 */

import { useCallback, useEffect, useRef } from 'react';

import {
  useHorizontalResize,
  type HorizontalResizeResult,
} from '@/hooks/useHorizontalResize';
import {
  RSB_TREE_WIDTH_KEY_PREFIX,
  RSB_TREE_WIDTH_LAST_KEY,
} from '@/lib/sessionLayoutPrefs';

export const TREE_DEFAULT_WIDTH = 200;
export const TREE_MIN_WIDTH = 140;
/** 静态上限,作为 useHorizontalResize 的 maxWidth 默认值;真正的动态上限会按容器宽传入。 */
export const TREE_MAX_WIDTH = 500;

function readNumber(key: string): number | null {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** per-session → `:last` → default。sessionId 为空返回 default、不读 storage。 */
function readWidthForSession(sessionId: string | null): number {
  if (!sessionId) return TREE_DEFAULT_WIDTH;
  const perSession = readNumber(`${RSB_TREE_WIDTH_KEY_PREFIX}${sessionId}`);
  if (perSession !== null) return perSession;
  const last = readNumber(RSB_TREE_WIDTH_LAST_KEY);
  if (last !== null) return last;
  return TREE_DEFAULT_WIDTH;
}

function persistLast(width: number): void {
  try {
    localStorage.setItem(RSB_TREE_WIDTH_LAST_KEY, String(width));
  } catch {
    // ignore
  }
}

function removePerSession(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    localStorage.removeItem(`${RSB_TREE_WIDTH_KEY_PREFIX}${sessionId}`);
  } catch {
    // ignore
  }
}

export interface SessionScopedTreeWidthOptions {
  sessionId: string | null;
  /** 来自 FileBrowserBody 的运行时动态上限(容器宽 − body 留白)。 */
  dynamicTreeMax: number;
}

/**
 * 返回与 useHorizontalResize 等价的句柄;调用方按原样消费 width / isDragging /
 * handleDragStart / resetWidth / setWidth。区别仅在内部多了 per-session 读取链
 * 与 `:last` 镜像。
 */
export function useSessionScopedTreeWidth({
  sessionId,
  dynamicTreeMax,
}: SessionScopedTreeWidthOptions): HorizontalResizeResult {
  // sessionId 透 ref 给镜像逻辑(避免每次 sessionId 变都重建 callback)。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // 内层 hook 的 storageKey 用 per-session key。sessionId 变化时 key 字符串跟着变,
  // 内层的 persistWidth 自然写到新 key;但内层 useState(() => readPersistedWidth) 只在
  // mount 时读一次,所以下面专门加个 effect 来处理 sessionId 变化时的 state 重置。
  const storageKey = sessionId
    ? `${RSB_TREE_WIDTH_KEY_PREFIX}${sessionId}`
    : `${RSB_TREE_WIDTH_KEY_PREFIX}__none__`;

  // 初始 defaultWidth:per-session 没值时 useHorizontalResize 会落到这里。我们让它
  // 直接读 `:last`,fallback 不到再用硬编码 —— 等价于把 fallback 链做在了内层 hook 之外。
  const initialDefaultWidth = useRef(readWidthForSession(sessionId)).current;

  const inner = useHorizontalResize({
    storageKey,
    defaultWidth: initialDefaultWidth,
    minWidth: TREE_MIN_WIDTH,
    maxWidth: dynamicTreeMax,
    invert: true,
  });

  // 用 ref 缓存 inner.setWidth / isDragging —— inner 每次 render 都是新对象引用,如果
  // 直接放 effect deps,effect 会每次 render 都跑,得不到"仅 sessionId 真变化时触发"
  // 的语义。这里把 inner 字段透到 ref,effect 只依赖 sessionId / 镜像逻辑只依赖 width。
  const innerSetWidthRef = useRef(inner.setWidth);
  innerSetWidthRef.current = inner.setWidth;
  const innerIsDraggingRef = useRef(inner.isDragging);
  innerIsDraggingRef.current = inner.isDragging;

  // sessionId 切换 → 重读 storage 并主动 setWidth。内层的 setWidth 会把 next 持久化到
  // 新的 per-session key,把 fallback 物化到新 session(预期行为)。拖拽中跳过。
  // 首次 mount 时这里读到的值 == initialDefaultWidth,setWidth 写一次 per-session 也无 side effect。
  useEffect(() => {
    if (innerIsDraggingRef.current) return;
    const next = readWidthForSession(sessionId);
    innerSetWidthRef.current(next);
  }, [sessionId]);

  // 用户主动动作后镜像到 `:last`:用 isDragging 下降沿(true → false)= 拖拽松手时机。
  // 拖拽中频繁触发会浪费 storage IO,所以只在松手时一次性写。
  const prevDraggingRef = useRef(inner.isDragging);
  useEffect(() => {
    const wasDragging = prevDraggingRef.current;
    prevDraggingRef.current = inner.isDragging;
    if (wasDragging && !inner.isDragging && sessionIdRef.current) {
      persistLast(inner.width);
    }
  }, [inner.isDragging, inner.width]);

  // setWidth 包装:命令式设宽时,内层写 per-session,wrapper 同步镜像到 `:last`。
  const setWidth = useCallback(
    (next: number) => {
      inner.setWidth(next);
      if (sessionIdRef.current) persistLast(next);
    },
    [inner],
  );

  // resetWidth 包装:显式用硬编码 TREE_DEFAULT_WIDTH(不走 inner.resetWidth —— 它会用
  // opts.defaultWidth,而我们传给内层的 defaultWidth 是 mount 时通过 readWidthForSession
  // 读到的 fallback / 继承值,reset 时若用那个会"复位到当时继承到的值"而不是硬默认)。
  // setWidth(200) → 内层会把 200 写进 per-session(暂时),wrapper 紧接着 removePerSession
  // 擦掉 + persistLast(200) 写 `:last`。最终态:per-session 无值、`:last` = 200、UI 显示 200。
  const resetWidth = useCallback(() => {
    inner.setWidth(TREE_DEFAULT_WIDTH);
    removePerSession(sessionIdRef.current);
    if (sessionIdRef.current) persistLast(TREE_DEFAULT_WIDTH);
  }, [inner]);

  return {
    width: inner.width,
    isDragging: inner.isDragging,
    handleDragStart: inner.handleDragStart,
    resetWidth,
    setWidth,
  };
}

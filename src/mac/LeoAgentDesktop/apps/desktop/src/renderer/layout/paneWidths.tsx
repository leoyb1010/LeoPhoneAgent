import { createContext, useContext } from 'react';

/**
 * paneWidths —— 引擎面板宽度通道(缝即把手,宽度主权归引擎)。
 *
 * 两个 context:
 * - ContentAvailableWidthContext:内容区可分配总宽(窗口宽 − 左栏宽),由
 *   MainLayout 的既有测量(B1a 的 sidebarBlock 观测)下发给 LayoutRoot;
 * - PaneWidthContext:LayoutRoot 按树上 fraction × 可用宽算出的**各面板像素宽**
 *   (按 panelKind 索引;chat-main 弹性吸收剩余,不在表内)。拖动引擎分割线
 *   期间为临时值(实时跟手),松手后回落到树的持久化值。
 *
 * 面板消费方式:usePanelWidth(自己的 kind) —— 返回 null 表示引擎未接管
 * (Provider 缺失 / 自己是弹性面板),面板回落自己的旧宽度来源。
 */

export const ContentAvailableWidthContext = createContext<number | null>(null);
export const ContentAvailableWidthProvider = ContentAvailableWidthContext.Provider;

export function useContentAvailableWidth(): number | null {
  return useContext(ContentAvailableWidthContext);
}

export const PaneWidthContext = createContext<Record<string, number> | null>(null);
export const PaneWidthProvider = PaneWidthContext.Provider;

/** 读取引擎为某 panelKind 计算的像素宽;null = 引擎未接管,面板自行回落。 */
export function usePanelWidth(kind: string): number | null {
  const widths = useContext(PaneWidthContext);
  return widths?.[kind] ?? null;
}

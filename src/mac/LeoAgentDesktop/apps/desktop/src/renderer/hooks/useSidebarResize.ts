/**
 * useSidebarResize — 主侧边栏 resize 的薄封装
 * ---------------------------------------------------------------------------
 * 实际逻辑在通用 useHorizontalResize 里；本 hook 只锁死侧边栏自己的常量
 * （key / 默认 / 上下限），保留旧 API 以免改动调用方（MainLayout 等）。
 */

import { useHorizontalResize } from './useHorizontalResize';

const SIDEBAR_WIDTH_KEY = 'sidebar-width';
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
/** 拖到该宽度以下进入 rail 模式（redesign 稿 T=120）。 */
const RAIL_THRESHOLD = 120;
/** rail 模式宽度——与 Sidebar.tsx 的 RAIL_WIDTH 保持一致(78px 容纳 macOS 红绿灯)。 */
const RAIL_WIDTH = 78;
/** 卡片版「2 列最佳最小宽」磁吸停靠点(侧栏宽):
 *  CardMasonry 容器 ≥246(TWO_COL_MIN_WIDTH)进 2 列;容器 = 侧栏宽 − ~25
 *  (1px 边框 + 12 scrollbar-gutter + 12 pl-3),故 246+25≈271,取 272 留 1px 余量
 *  保证落点稳进 2 列。拖到此宽自动停留 = 最窄 2 列最佳适配,可继续右拉变宽。
 *  仅卡片版生效(列概念只在卡片版存在)。 */
const TWO_COL_SNAP_WIDTH = 272;

export interface SidebarResizeRailOptions {
  /** 当前是否处于 rail 模式（状态由 MainLayout 持有并持久化）。 */
  railMode: boolean;
  onRailModeChange: (on: boolean) => void;
}

export function useSidebarResize(railOpts?: SidebarResizeRailOptions, cardMode = false) {
  return useHorizontalResize({
    storageKey: SIDEBAR_WIDTH_KEY,
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    rail: railOpts
      ? {
          active: railOpts.railMode,
          threshold: RAIL_THRESHOLD,
          railWidth: RAIL_WIDTH,
          onChange: railOpts.onRailModeChange,
        }
      : undefined,
    // 卡片版才挂 2 列磁吸停靠(列概念只在卡片版存在);文字版无停靠点,自由拖。
    snapPoints: cardMode ? [TWO_COL_SNAP_WIDTH] : undefined,
  });
}

/**
 * ChromeActions 与各窗口 drag region 后代挖洞共用的几何约束。
 *
 * Electron 只会可靠识别 drag 元素后代上的 no-drag 区域，因此浮层按钮的位置和
 * 底层挖洞必须引用同一组数值，不能在 Sidebar / ContentHeader / RightSidebar 中
 * 各自维护魔法数。
 */
export const CHROME_ACTIONS_GEOMETRY = {
  /** Windows 与 macOS 全屏时，按钮簇距离窗口左边缘的距离。 */
  defaultLeft: 8,
  /** macOS 非全屏时，按钮簇为红绿灯预留空间后的左偏移。 */
  macTrafficLightLeft: 78,
  /** 两个 28px 按钮加 4px 间距的总宽度。 */
  clusterWidth: 60,
} as const;

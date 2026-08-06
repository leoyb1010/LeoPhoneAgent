/**
 * RightSidebarToggle — 工具面板开关按钮（纯图标，无选中底色）
 * ---------------------------------------------------------------------------
 * 单一一份裸图标按钮，两处复用，两平台同款样式、不同落点：
 *   - Mac：放在 ContentHeader 右端（mac 那侧没有窗口控制按钮，这个位置本就空着）。
 *   - Windows：右栏折叠后放在全屏聊天视图的 chip 栈第一行 —— 落在哪个角由 `side` 决定
 *     (B2b 去方位化:面板贴哪侧,展开入口就留守哪侧的 top-3 角,与 DiffPanelToggle /
 *     PrevMessageJumpChip 同层(content 层,z-20),随聊天视图天然出现/消失);展开态的
 *     折叠入口放在右栏自身 TabBar 内,不悬在聊天内容上。
 * resting 无底无边、仅 hover 底色（用户明确这个开关不要圆底；chip 栈里下方两个
 * chip 保留圆底，裸图标 + 圆底 chip 连成一列）。两种尺寸（size prop）：
 *   - 'chip'（默认，h-7 / 图标 15 / rounded-full）：与 chip 栈内其它 chip 对齐，
 *     供 Windows chip 栈用。
 *   - 'toolbar'（h-7 / 图标 15 / rounded-md）：与左栏折叠按钮（ChromeActions 的
 *     PanelLeft，同为 28px / 15 / rounded-md 规格族）对齐，供 mac 右上浮层用
 *     （2026-07 随左簇一起从 36px 缩到 28px，左右对称）。
 * chip 栈容器是 pointer-events-none，本按钮自带 `pointer-events-auto` 才能接收点击
 * （Windows chip 栈约束；mac 在 ContentHeader 里无副作用）。图标随 `side` 翻转:
 * 面板在右 = lucide `PanelRight`(与左栏 `PanelLeft` 对称),面板在左 = `PanelLeft`
 * ——图标画的就是"面板贴哪条边",跟着面板走才不说谎。
 */

import { PanelLeft, PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

interface RightSidebarToggleProps {
  /** 右栏是否折叠（用于 aria-expanded）。 */
  collapsed: boolean;
  onToggle: () => void;
  /**
   * 尺寸变体：'chip'（默认，rounded-full，Windows chip 栈与其它 chip 对齐）
   * / 'toolbar'（rounded-md，mac 右上浮层与左栏折叠按钮同规格族）。
   * 两变体同为 h-7 / 图标 15，仅圆角语义不同。
   */
  size?: 'chip' | 'toolbar';
  /** 面板当前贴哪条边(B2b:由布局树推导,经 MainLayout 下发);决定图标方向。默认 'right'。 */
  side?: 'left' | 'right';
}

export function RightSidebarToggle({
  collapsed,
  onToggle,
  size = 'chip',
  side = 'right',
}: RightSidebarToggleProps) {
  const { t } = useTranslation();
  const isToolbar = size === 'toolbar';
  const Icon = side === 'left' ? PanelLeft : PanelRight;

  return (
    <button
      type="button"
      className={cn(
        'pointer-events-auto flex h-7 w-7 items-center justify-center',
        isToolbar ? 'rounded-md' : 'rounded-full',
        'text-titlebar-icon',
        'transition-colors',
        'hover:bg-titlebar-button-hover',
      )}
      onClick={onToggle}
      // B2c:文案只说动作(折叠/展开),不提"右栏"等方位名词 —— 按钮按位置寻址,
      // 管的是"贴这条缘的面板",绑定方位词会在面板换侧后说谎。
      aria-label={t(collapsed ? 'contentHeader.expandPanel' : 'contentHeader.collapsePanel')}
      title={t(collapsed ? 'contentHeader.expandPanel' : 'contentHeader.collapsePanel')}
      aria-expanded={!collapsed}
    >
      <Icon size={15} />
    </button>
  );
}

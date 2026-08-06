import Svg, { Path } from 'react-native-svg';

/**
 * PaperPlaneIcon —— 移动端「发送」按钮的纸飞机图标(实心填充,无描边)。
 *
 * 与桌面端 apps/desktop/src/renderer/components/new-chat/SendButton.tsx 的
 * CreateAgentSendIcon 同源:同一 SVG path(viewBox 0 0 24 24, fill currentColor),
 * 仅把 web SVG 换成 react-native-svg 实现,颜色由调用方经 color prop 注入,
 * 尺寸经 size prop 注入(走 iconSize 阶梯 token)。LIGHT/DARK 双模式由
 * 调用方传入对应 theme colors 取值(ctaText / textSecondary)驱动,组件自身不感知主题。
 */
interface PaperPlaneIconProps {
  /** 图标填充色;由调用方按 enable/disabled 分支传入 theme color token 取值。 */
  color: string;
  /** 图标边长;走 iconSize 阶梯 token(发送按钮场景用 iconSize.lg)。 */
  size: number;
}

export function PaperPlaneIcon({ color, size }: PaperPlaneIconProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
    >
      <Path fill={color} d="M2.6 3.35a1 1 0 0 1 1.08-.13l17.2 8a.88.88 0 0 1 0 1.56l-17.2 8A1 1 0 0 1 2.3 19.6l2.04-6.44L13 12 4.34 10.84 2.3 4.4a1 1 0 0 1 .3-1.05Z" />
    </Svg>
  );
}

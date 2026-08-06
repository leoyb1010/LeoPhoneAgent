import { useRef } from 'react';
import { LayoutAnimation, Platform, UIManager } from 'react-native';

// 旧架构 Android 需要显式开启 LayoutAnimation;新架构(Fabric)下该开关是 no-op。
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** 与 iOS 键盘弹出动画同量级的时长，让卡片展开与键盘上滑视觉上是同一段运动。 */
const CARD_TRANSITION_DURATION_MS = 250;

/**
 * Composer 简洁态 ↔ 聚焦卡片态切换的布局过渡动画。
 *
 * 检测 cardActive 翻转时注册一次 LayoutAnimation，让下一帧的布局变化
 * （输入行变全宽、工具排出现 / 消失、卡片高度与圆角变化、消息列表 padding 联动）
 * 整体平滑过渡，而不是硬切。
 *
 * 切换入口分散（聚焦 / blur / 各面板 toggle / 语音状态异步变化），无法在每个
 * 事件处理器里注册；LayoutAnimation.configureNext 只是给下一次 native 布局
 * 提交打标记、并非副作用 setState，因此在 render 期间按状态翻转调用一次是
 * 安全且唯一集中的挂点（重复调用幂等）。
 *
 * 三段动画的分工：
 * - update：存活视图的位置 / 尺寸平滑（卡片长高、输入行变全宽、absolute 锚点的
 *   麦克风从行内滑到工具排——常驻按钮靠它保持连续，不闪不跳）；
 * - create / delete（opacity）：工具排按钮（加号 / 权限 / 模型 / 发送）只在
 *   卡片态挂载，出现时在最终位置原地渐显、收起时原地渐隐，没有位移感。
 */
export function useComposerCardTransition(cardActive: boolean): void {
  const prevRef = useRef(cardActive);
  if (prevRef.current !== cardActive) {
    prevRef.current = cardActive;
    LayoutAnimation.configureNext({
      create: { property: 'opacity', type: 'easeInEaseOut' },
      delete: { property: 'opacity', type: 'easeInEaseOut' },
      duration: CARD_TRANSITION_DURATION_MS,
      update: { type: 'easeInEaseOut' },
    });
  }
}

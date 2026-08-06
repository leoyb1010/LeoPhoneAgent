import { LayoutAnimation, Platform, UIManager } from 'react-native';

import { getCachedReduceMotionEnabled } from '@/hooks/useReduceMotion';

// Android 旧架构必须显式开启,否则 LayoutAnimation.configureNext 直接 no-op
// (收起/展开会瞬间跳变,违反 §14.4「杜绝跳变」)。新架构默认开启,这里幂等且安全。
// iOS 无需此调用。模块加载时执行一次。
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * 收起 / 展开统一的功能性过渡(§14.4):≤150ms easeInEaseOut + 透明度淡入淡出,
 * 避免内容瞬间增删跳变。首页项目组 / 置顶组、设置页折叠分组共用,保持一致手感。
 */
export function configureCollapseAnimation(): void {
  // 系统开了「减弱动态效果」就不配置下一帧布局动画,直切(review 反馈;
  // 缓存为 null 的首帧窗口按播处理——布局动画非 mount 抢跑型,可接受)。
  if (getCachedReduceMotionEnabled() === true) return;
  LayoutAnimation.configureNext({
    duration: 150,
    create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    update: { type: LayoutAnimation.Types.easeInEaseOut },
    delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  });
}

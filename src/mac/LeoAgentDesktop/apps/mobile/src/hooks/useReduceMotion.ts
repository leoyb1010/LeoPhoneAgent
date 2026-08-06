/**
 * useReduceMotionEnabled —— 系统「减弱动态效果」偏好的共享 hook。
 *
 * 返回三态:null = 尚未查询到(首帧),true / false = 系统偏好。消费方约定:
 * **只有 === false 才播动画**,null 一律按"不播"降级——查询是异步的,首帧
 * 宁可少一次动画,也不能让 reduce-motion 用户先看到动一下再停(a11y 红线)。
 *
 * 模块级缓存:首次查询结果落到 cached,后续任何组件 mount 都能同步拿到
 * 初值(mount 型一次性动画因此不会因为异步查询而永远错过播放窗口)。
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

let cached: boolean | null = null;
// 模块加载即预热缓存(纯只读系统查询,无落盘副作用),并常驻订阅系统偏好
// 变更——没有任何 hook 订阅者挂载的窗口里用户切换了偏好,缓存也保持新鲜,
// 后续 mount 型一次性动画不会拿着陈旧的 false 抢跑(review 反馈)。
// app 生命周期单例,不移除。
void AccessibilityInfo.isReduceMotionEnabled()
  .then((enabled) => {
    cached = enabled;
  })
  .catch(() => {
    cached = false;
  });
AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
  cached = enabled;
});

/**
 * 同步读当前缓存值(null = 尚未查询到)。给无法走 hook 的命令式调用点用
 * (如 LayoutAnimation 配置);消费方同样遵循「只有 === false 才播」约定,
 * 或按场景对 true 明确降级。
 */
export function getCachedReduceMotionEnabled(): boolean | null {
  return cached;
}

export function useReduceMotionEnabled(): boolean | null {
  const [value, setValue] = useState<boolean | null>(cached);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        cached = enabled;
        if (active) setValue(enabled);
      })
      .catch(() => {
        cached = false;
        if (active) setValue(false);
      });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      cached = enabled;
      setValue(enabled);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return value;
}

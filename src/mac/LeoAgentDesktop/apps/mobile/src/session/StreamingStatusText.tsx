/**
 * StreamingStatusText —— 流式生成中的状态文字,带 opacity 呼吸(1 ↔ 0.45,
 * 单周期 1.4s)。对齐桌面端 running 呼吸语义(DESIGN.md §14.4「运行中」原型):
 * 纯 opacity、native driver,JS 线程零每帧开销;仅在流式期间挂载,卸载即停。
 * 遵循系统减弱动态偏好:reduce-motion 下保持静态文字(useReduceMotionEnabled
 * 三态约定,null 不播)。
 */
import { type ReactNode, useEffect, useRef } from 'react';
import { Animated, Easing, type StyleProp, type TextStyle } from 'react-native';

import { MAX_FONT_SIZE_MULTIPLIER } from '@/components/AppText';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';

export function StreamingStatusText({
  accessibilityLabel,
  children,
  style,
  testID,
}: {
  accessibilityLabel?: string;
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const reduceMotionEnabled = useReduceMotionEnabled();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotionEnabled !== false) {
      opacity.stopAnimation();
      opacity.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          isInteraction: false,
          toValue: 0.45,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          isInteraction: false,
          toValue: 1,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      opacity.setValue(1);
    };
  }, [opacity, reduceMotionEnabled]);

  return (
    <Animated.Text
      accessibilityLabel={accessibilityLabel}
      // 裸 Animated.Text 绕过了 AppText 包装,字号放大上限要自己补齐,
      // 与全 app 文本同一 cap(review 反馈)。
      maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
      style={[style, reduceMotionEnabled === false ? { opacity } : undefined]}
      testID={testID}
    >
      {children}
    </Animated.Text>
  );
}

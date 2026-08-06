import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, type GestureResponderHandlers } from 'react-native';
import {
  applyContextSheetDrag,
  settleContextSheetDrag,
  type ContextSheetSnap,
  type ContextSheetSnapHeights,
} from '@/session/contextSheetModel';

/** 松手时位移小于该值视为轻点而非拖动，不触发档位结算。 */
const DRAG_ACTIVATION_THRESHOLD = 3;
/** 档位吸附动画时长；与 Modal slide 的节奏保持接近。 */
const SNAP_ANIMATION_DURATION_MS = 180;

export interface UseContextSheetDragInput {
  heights: ContextSheetSnapHeights;
  snap: ContextSheetSnap;
  onSnapChange: (snap: ContextSheetSnap) => void;
  onDismiss: () => void;
}

export interface UseContextSheetDragResult {
  /** 面板当前呈现高度；拖动 / 吸附动画期间由 Animated 驱动，不触发整页 re-render。 */
  animatedHeight: Animated.Value;
  /** 拖动进行中（内容区可据此暂停滚动等）。 */
  dragging: boolean;
  /** 传给 grabber / header 拖动区的手势 handlers。 */
  panHandlers: GestureResponderHandlers;
}

/**
 * Context 面板拖动换档的手势与动画编排。
 *
 * 沿用 useComposerResize 的模式：拖动期间只 setValue（JS 驱动布局高度），
 * 松手按 contextSheet 纯函数结算——吸附到 half / full 时先动画到目标高度再落 state，
 * 判定 dismiss 时直接回调关闭（Modal 自带滑出动画）。
 */
export function useContextSheetDrag(input: UseContextSheetDragInput): UseContextSheetDragResult {
  const [dragging, setDragging] = useState(false);

  const heightAnim = useRef(new Animated.Value(input.heights[input.snap])).current;

  // PanResponder 回调生命周期长于 render，经 ref 读取最新值。
  const heightsRef = useRef(input.heights);
  heightsRef.current = input.heights;
  const snapRef = useRef(input.snap);
  snapRef.current = input.snap;
  const onSnapChangeRef = useRef(input.onSnapChange);
  onSnapChangeRef.current = input.onSnapChange;
  const onDismissRef = useRef(input.onDismiss);
  onDismissRef.current = input.onDismiss;
  const draggingRef = useRef(false);
  const dragStartRef = useRef(0);
  const dragLastRef = useRef(0);

  // 非拖动期间，snap / 屏幕尺寸变化时把高度动画到当前档位。
  useEffect(() => {
    if (draggingRef.current) return;
    Animated.timing(heightAnim, {
      duration: SNAP_ANIMATION_DURATION_MS,
      toValue: input.heights[input.snap],
      useNativeDriver: false,
    }).start();
  }, [heightAnim, input.heights, input.snap]);

  const panResponder = useMemo(() => {
    const settle = () => {
      draggingRef.current = false;
      setDragging(false);
      const moved = Math.abs(dragLastRef.current - dragStartRef.current) >= DRAG_ACTIVATION_THRESHOLD;
      if (!moved) {
        heightAnim.setValue(heightsRef.current[snapRef.current]);
        return;
      }
      const target = settleContextSheetDrag({
        draggedHeight: dragLastRef.current,
        heights: heightsRef.current,
      });
      if (target === 'dismiss') {
        onDismissRef.current();
        return;
      }
      Animated.timing(heightAnim, {
        duration: SNAP_ANIMATION_DURATION_MS,
        toValue: heightsRef.current[target],
        useNativeDriver: false,
      }).start(() => {
        if (target !== snapRef.current) onSnapChangeRef.current(target);
      });
    };
    return PanResponder.create({
      // 兜底保留 move 阶段协商;但在 Fabric 新架构下 Modal 内 move 阶段的 responder
      // 协商不会被触发(start 阶段与已授权 responder 的 move 事件均正常——面板内
      // Pressable 可点、backdrop 能跨 move 收到 release),所以真正生效的是下面的
      // touch-down 认领。
      onMoveShouldSetPanResponder: (_event, gestureState) =>
        Math.abs(gestureState.dy) > DRAG_ACTIVATION_THRESHOLD
        && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
      onPanResponderGrant: () => {
        dragStartRef.current = heightsRef.current[snapRef.current];
        dragLastRef.current = dragStartRef.current;
        heightAnim.setValue(dragStartRef.current);
        draggingRef.current = true;
        setDragging(true);
      },
      onPanResponderMove: (_event, gestureState) => {
        const next = applyContextSheetDrag({
          heights: heightsRef.current,
          startHeight: dragStartRef.current,
          translationY: gestureState.dy,
        });
        dragLastRef.current = next;
        heightAnim.setValue(next);
      },
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
      // touch-down 即认领:拖动区(grabber + header 底)没有可点内容,header 里的
      // 关闭 / 返回按钮是更深层的 Pressable、协商时优先于本区,不受影响;轻点无位移
      // 时 settle 的 moved 阈值会直接复位,不产生档位变化。
      onStartShouldSetPanResponder: () => true,
      // 已接管的拖动不许被父级(ScrollView 等)中途抢走,避免拖到一半面板卡在中间。
      onPanResponderTerminationRequest: () => false,
    });
  }, [heightAnim]);

  return {
    animatedHeight: heightAnim,
    dragging,
    panHandlers: panResponder.panHandlers,
  };
}

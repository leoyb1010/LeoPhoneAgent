import { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, type GestureResponderHandlers } from 'react-native';
import {
  MOBILE_COMPOSER_INPUT_LINE_HEIGHT,
  MOBILE_COMPOSER_INPUT_VERTICAL_PADDING,
} from '@/session/MobileComposerInputRow';
import {
  COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD,
  applyComposerResizeDrag,
  buildComposerResizeGestureConfig,
  buildComposerResizeTouchHandlers,
  computeComposerResizeBounds,
  resolveComposerInputHeight,
  settleComposerResizeDrag,
  shouldDismissComposerOnRelease,
  type ComposerResizeMode,
} from '@/session/composerResize';

/** grabber 需要挂载的全部触摸 props：PanResponder handlers + 原生触摸监听。 */
export type ComposerResizeGrabberHandlers = GestureResponderHandlers & {
  onTouchCancel: () => void;
  onTouchEnd: () => void;
  onTouchStart: () => void;
};

export interface UseComposerResizeInput {
  /** TextInput 上报的内容高度（页面既有 state）。 */
  contentHeight: number;
  /** auto 模式的内容高度上限（页面既有 max 计算结果）。 */
  autoMaxContentHeight: number;
  /** 窗口高度（useWindowDimensions().height）。 */
  windowHeight: number;
  /** 键盘可见高度；收起时传 0。 */
  keyboardHeight: number;
  /** 单行内容高度。 */
  singleLineContentHeight: number;
  /** composer 除输入区之外占用的高度（状态行、工具行等）。 */
  composerChromeHeight: number;
  /**
   * 简洁态（非激活卡片态）时置 true：输入框一律收到单行（下拉收起和点别处
   * 收键盘的结果一致）；auto / manual 记忆保留，重新激活后恢复。
   */
  collapsed?: boolean;
  /**
   * 松手结算吸附回 auto（把 grabber 拖回单行高度附近）时回调。
   * 页面可借此让输入框 blur、退出聚焦卡片态——「拖到底 = 想收起」。
   */
  onSnapToAuto?: () => void;
  /**
   * grabber 触摸按下 / 抬手（touch-down 即回调，早于手势认领与 dragging）。
   * 页面用它同步关闭外壳 ScrollView 的原生滚动（setNativeProps 直改原生属性,
   * 不能走 setState——touch-down 触发整页 re-render 会阻塞 JS 线程，move
   * 事件被合并延后，位移在 grant 重置 dx/dy 前就被烧光，拖拽变成「没反应」）。
   */
  onGrabberTouchActiveChange?: (active: boolean) => void;
}

export interface UseComposerResizeResult {
  /** 拖动进行中（页面可据此暂停外层 ScrollView 滚动）。 */
  dragging: boolean;
  mode: ComposerResizeMode;
  /** 输入区当前应呈现的内容高度（非拖动时的解析结果）。 */
  visibleContentHeight: number;
  /** TextInput 内部滚动开关(激活态恒 true,语义见 ComposerInputHeightModel.scrollEnabled)。 */
  scrollEnabled: boolean;
  /**
   * 传给 MobileComposerInputRow 的 inputFrameHeight：
   * 拖动中是 Animated 值（跟手、不触发 re-render）；manual 定高时是数值；auto 时为 null。
   */
  frameHeight: Animated.Value | number | null;
  /** manual / 拖动时传给 TextInput 的 maxHeight，放开到拖拽上限。 */
  inputMaxHeight: number;
  /**
   * 拖拽上限对应的 inputFrame 高度。manual / 拖动时 composer 外层容器的
   * maxHeight 需要放开到「该值 + chrome」，否则输入区拖高后容器被原有
   * 上限钳住、从底部裁剪掉发送按钮等 trailing 行。
   */
  maxFrameHeight: number;
  /** 传给 ComposerResizeGrabber 的手势 handlers（含 grabberTouchActive 触摸监听）。 */
  panHandlers: ComposerResizeGrabberHandlers;
  /** 恢复 auto 自动增长模式。 */
  reset: () => void;
  /**
   * 无障碍步进调高：按一行行高增减输入区高度（VoiceOver / TalkBack 的
   * increment / decrement 动作），语义与拖拽一致（clamp 边界、调到底吸附回 auto）。
   */
  adjustByLine: (direction: 1 | -1) => void;
}

/**
 * Composer 输入区拖拽调高的手势与状态编排。
 *
 * 拖动期间只更新 Animated.Value（JS 驱动布局高度），不做 per-frame setState，
 * 避免整页 re-render；松手时一次性把结算高度落进 state。高度决策全部走
 * composerResize 纯函数模型。
 */
export function useComposerResize(input: UseComposerResizeInput): UseComposerResizeResult {
  const [userContentHeight, setUserContentHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const bounds = useMemo(() => computeComposerResizeBounds({
    autoMaxContentHeight: input.autoMaxContentHeight,
    composerChromeHeight: input.composerChromeHeight,
    keyboardHeight: input.keyboardHeight,
    singleLineContentHeight: input.singleLineContentHeight,
    windowHeight: input.windowHeight,
  }), [
    input.autoMaxContentHeight,
    input.composerChromeHeight,
    input.keyboardHeight,
    input.singleLineContentHeight,
    input.windowHeight,
  ]);

  const model = resolveComposerInputHeight({
    autoMaxContentHeight: input.autoMaxContentHeight,
    bounds,
    collapsed: input.collapsed,
    contentHeight: input.contentHeight,
    userContentHeight,
  });

  // PanResponder 回调生命周期长于 render，经 ref 读取最新值。
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const visibleContentHeightRef = useRef(model.visibleContentHeight);
  visibleContentHeightRef.current = model.visibleContentHeight;
  const onSnapToAutoRef = useRef(input.onSnapToAuto);
  onSnapToAutoRef.current = input.onSnapToAuto;
  const onGrabberTouchActiveChangeRef = useRef(input.onGrabberTouchActiveChange);
  onGrabberTouchActiveChangeRef.current = input.onGrabberTouchActiveChange;
  const contentHeightRef = useRef(input.contentHeight);
  contentHeightRef.current = input.contentHeight;

  const dragAnim = useRef(new Animated.Value(0)).current;
  const dragStartRef = useRef(0);
  const dragLastRef = useRef(0);

  // 手势认领 / 让出策略集中在 buildComposerResizeGestureConfig(纯函数,单测
  // 锁行为):capture 认领竖直拖动 + 拒绝 termination request,保证 grabber 在
  // ScrollView 内(会话页 composer 外壳)拖动时不被原生滚动抢走手势。
  const panResponder = useMemo(() => {
    const settle = (translationY: number) => {
      const moved = Math.abs(dragLastRef.current - dragStartRef.current)
        >= COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD;
      if (moved) {
        setUserContentHeight(settleComposerResizeDrag({
          bounds: boundsRef.current,
          contentHeight: contentHeightRef.current,
          draggedContentHeight: dragLastRef.current,
        }));
      }
      // 下拉收起判定独立于高度变化量:输入框本来就一行时向下拖,高度被 clamp
      // 纹丝不动(moved 恒 false),但手势位移真实存在,同样应该退出激活态。
      if (shouldDismissComposerOnRelease({
        bounds: boundsRef.current,
        draggedContentHeight: dragLastRef.current,
        translationY,
      })) {
        onSnapToAutoRef.current?.();
      }
      setDragging(false);
    };
    const config = buildComposerResizeGestureConfig({
      onEnd: settle,
      onGrant: () => {
        dragStartRef.current = visibleContentHeightRef.current;
        dragLastRef.current = dragStartRef.current;
        dragAnim.setValue(toFrameHeight(dragStartRef.current));
        setDragging(true);
      },
      onMove: (translationY) => {
        const next = applyComposerResizeDrag({
          bounds: boundsRef.current,
          startContentHeight: dragStartRef.current,
          translationY,
        });
        dragLastRef.current = next;
        dragAnim.setValue(toFrameHeight(next));
      },
    });
    return {
      responder: PanResponder.create(config),
      touchHandlers: buildComposerResizeTouchHandlers((active) => {
        onGrabberTouchActiveChangeRef.current?.(active);
      }),
    };
  }, [dragAnim]);

  const reset = useCallback(() => setUserContentHeight(null), []);

  const adjustByLine = useCallback((direction: 1 | -1) => {
    const next = applyComposerResizeDrag({
      bounds: boundsRef.current,
      startContentHeight: visibleContentHeightRef.current,
      // 向上（增高）为负位移，与 grabber 拖拽同一坐标系。
      translationY: -direction * MOBILE_COMPOSER_INPUT_LINE_HEIGHT,
    });
    setUserContentHeight(settleComposerResizeDrag({
      bounds: boundsRef.current,
      contentHeight: contentHeightRef.current,
      draggedContentHeight: next,
    }));
  }, []);

  // 简洁态(collapsed)必须显式定高:auto 模式下 TextInput 是内容自增长的,
  // 不给 frame 定高的话多行草稿的简洁态仍会撑到内容高度。
  const frameHeight = dragging
    ? dragAnim
    : input.collapsed === true || model.mode === 'manual'
      ? toFrameHeight(model.visibleContentHeight)
      : null;

  // auto 分支保持页面原有 maxHeight 语义（不加 padding 补偿），避免行为漂移；
  // manual / 拖动时必须放开到拖拽上限对应的 frame 高度，否则 TextInput 的
  // maxHeight 会顶住 stretch，输入区撑不满定高的 frame。
  const inputMaxHeight = dragging || model.mode === 'manual'
    ? toFrameHeight(bounds.maxContentHeight)
    : input.autoMaxContentHeight;

  return {
    adjustByLine,
    dragging,
    frameHeight,
    inputMaxHeight,
    maxFrameHeight: toFrameHeight(bounds.maxContentHeight),
    mode: model.mode,
    panHandlers: { ...panResponder.responder.panHandlers, ...panResponder.touchHandlers },
    reset,
    scrollEnabled: model.scrollEnabled,
    visibleContentHeight: model.visibleContentHeight,
  };
}

/** 内容高度 → inputFrame 高度（补上输入框上下 padding）。 */
function toFrameHeight(contentHeight: number): number {
  return contentHeight + MOBILE_COMPOSER_INPUT_VERTICAL_PADDING * 2;
}

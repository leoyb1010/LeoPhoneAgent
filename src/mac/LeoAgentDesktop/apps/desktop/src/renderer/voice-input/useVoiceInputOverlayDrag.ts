import { useCallback, useEffect, useRef } from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * 语音输入全局浮窗的拖动 / 双击复位手势 hook。
 *
 * 手势识别在 renderer,窗口几何全部在 main:
 * - pointerdown(非交互控件)即通知 main 快照拖动起点(bounds + 系统光标),
 *   但只有移动超过阈值才进入 dragging 并开始发 move tick——普通点击不会
 *   被识别为拖动,也不会触发落盘。
 * - move tick 按 requestAnimationFrame 节流(每帧最多一次 fire-and-forget
 *   IPC),不携带坐标、不 setState,拖动过程零 React 重渲染。
 * - 交互控件(按钮等)自带 pointerdown stopPropagation,此外这里再按
 *   closest 兜底排除,双击按钮不会误触发复位。
 */

const DRAG_START_THRESHOLD_PX = 4;
const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"]';

type DragPhase = 'idle' | 'pending' | 'dragging';

export type VoiceInputOverlayDragHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_SELECTOR));
}

export function useVoiceInputOverlayDrag(): VoiceInputOverlayDragHandlers {
  const phaseRef = useRef<DragPhase>('idle');
  const originRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (isInteractiveTarget(event.target)) return;
    phaseRef.current = 'pending';
    // pending 阶段窗口尚未移动,clientX/Y 是稳定的阈值参考;进入 dragging
    // 后不再读 renderer 坐标(main 直接读系统光标)。
    originRef.current = { x: event.clientX, y: event.clientY };
    window.electronAPI.voiceInput.beginGlobalOverlayDrag();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const phase = phaseRef.current;
    if (phase === 'idle') return;
    if (phase === 'pending') {
      const dx = event.clientX - originRef.current.x;
      const dy = event.clientY - originRef.current.y;
      if (dx * dx + dy * dy < DRAG_START_THRESHOLD_PX * DRAG_START_THRESHOLD_PX) return;
      phaseRef.current = 'dragging';
    }
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      if (phaseRef.current !== 'dragging') return;
      window.electronAPI.voiceInput.moveGlobalOverlayDrag();
    });
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const phase = phaseRef.current;
    phaseRef.current = 'idle';
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // 只有真实拖动过才让 main 落盘;普通点击(pending → idle)不改变
    // 记忆位置。
    if (phase === 'dragging') {
      window.electronAPI.voiceInput.endGlobalOverlayDrag();
    }
  }, []);

  const onDoubleClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (isInteractiveTarget(event.target)) return;
    void window.electronAPI.voiceInput.resetGlobalOverlayPosition();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick,
  };
}

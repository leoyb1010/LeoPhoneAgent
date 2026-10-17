import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * [leo] 终端左右分屏的分隔条(WP-24):拖动改左右比例,每侧至少 20%,双击回到对半。
 * 只管比例这一个 UI 局部状态;哪两个终端在分屏里由 terminalPanelState 的 splitSessionId 决定。
 */
export function useTerminalSplitDivider() {
  const [ratio, setRatio] = useState(0.5);
  const containerRef = useRef<HTMLDivElement>(null);
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || event.button !== 0) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) => {
      setRatio(Math.min(0.8, Math.max(0.2, (move.clientX - rect.left) / rect.width)));
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }, []);
  const reset = useCallback(() => setRatio(0.5), []);
  return { ratio, containerRef, onPointerDown, reset };
}

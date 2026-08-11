import { useEffect, useRef, useState } from 'react';

const REDUCE_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(REDUCE_MOTION_QUERY).matches;
}

/**
 * Tweens a numeric display value toward its target so dashboard metrics roll
 * instead of jumping. Uses a single requestAnimationFrame loop with an
 * ease-out-expo curve; collapses to an instant set under reduced-motion.
 *
 * The returned value is what should be rendered — format it at render time.
 */
export function useAnimatedNumber(target: number, durationMs = 500): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(target)) return undefined;
    const from = displayRef.current;
    if (from === target || prefersReducedMotion() || durationMs <= 0) {
      displayRef.current = target;
      setDisplay(target);
      return undefined;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      // ease-out-expo
      const eased = progress >= 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const next = from + (target - from) * eased;
      displayRef.current = next;
      setDisplay(next);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        displayRef.current = target;
        setDisplay(target);
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [target, durationMs]);

  return display;
}

/**
 * useChatRailResize — width state + drag handle for the workdir-browse view's
 * RIGHT-side chat rail.
 *
 * Mirrors `useMetaColumnResize` (skillhub) but inverted: the drag handle sits
 * on the LEFT edge of the rail, so a drag-right shrinks the rail and a
 * drag-left enlarges it.
 *
 * Bounds: default 400 / min 400 / max 1120.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'cc-agent.workdirBrowse.chatRailWidth.v1';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 400;
const MAX_WIDTH = 1120;

function getInitialWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
        return parsed;
      }
    }
  } catch {
    // localStorage not available — fall through
  }
  return DEFAULT_WIDTH;
}

function persistWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // silently ignore
  }
}

export function useChatRailResize() {
  const [width, setWidth] = useState(getInitialWidth);
  const [isDragging, setIsDragging] = useState(false);

  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const currentWidthRef = useRef(width);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!isDraggingRef.current) return;
    // INVERTED: handle is on left edge of right column → drag right = narrower
    const delta = e.clientX - startXRef.current;
    const newWidth = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, startWidthRef.current - delta),
    );
    setWidth(newWidth);
    currentWidthRef.current = newWidth;
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    persistWidth(currentWidthRef.current);
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove]);

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      isDraggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = currentWidthRef.current;
      setIsDragging(true);
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    },
    [handlePointerMove, handlePointerUp],
  );

  const resetWidth = useCallback(() => {
    setWidth(DEFAULT_WIDTH);
    currentWidthRef.current = DEFAULT_WIDTH;
    persistWidth(DEFAULT_WIDTH);
  }, []);

  useEffect(() => {
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  return { width, isDragging, handleDragStart, resetWidth } as const;
}

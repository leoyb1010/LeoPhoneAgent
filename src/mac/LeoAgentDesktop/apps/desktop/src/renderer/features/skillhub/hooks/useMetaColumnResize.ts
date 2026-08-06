/**
 * useMetaColumnResize — SkillHub 详情页左侧「使用表现 + 文件树」列宽状态。
 *
 * 与主侧边栏的 resize hook 形态相近,但使用独立 localStorage key 和边界值:
 * 详情页左栏的默认宽度、最小宽度都和主导航侧栏不是同一类交互。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'skillhub.metaColumnWidth.v1';
// 左栏现在放「使用表现 + 文件树」。默认宽度保持紧凑,避免挤压正文阅读区。
const DEFAULT_WIDTH = 196;
const MIN_WIDTH = 160;
const MAX_WIDTH = 520;
const KEYBOARD_STEP = 12;
const KEYBOARD_LARGE_STEP = 40;

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

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

export function useMetaColumnResize() {
  const [width, setWidth] = useState(getInitialWidth);
  const [isDragging, setIsDragging] = useState(false);

  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const currentWidthRef = useRef(width);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!isDraggingRef.current) return;
    const delta = e.clientX - startXRef.current;
    const newWidth = clampWidth(startWidthRef.current + delta);
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

  const resizeByKeyboard = useCallback((direction: -1 | 1, largeStep: boolean) => {
    const delta = (largeStep ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP) * direction;
    const newWidth = clampWidth(currentWidthRef.current + delta);
    setWidth(newWidth);
    currentWidthRef.current = newWidth;
    persistWidth(newWidth);
  }, []);

  useEffect(() => {
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  return {
    width,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    isDragging,
    handleDragStart,
    resizeByKeyboard,
    resetWidth,
  } as const;
}

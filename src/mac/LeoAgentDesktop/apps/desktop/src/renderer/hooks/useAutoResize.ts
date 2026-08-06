import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useAutoResize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight: number = 200,
): void {
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    // 1. Reset height to auto so scrollHeight reflects true content height
    el.style.height = 'auto';

    // 2. Calculate new height, capped at maxHeight
    const newHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${newHeight}px`;

    // 3. Enable vertical scroll when content exceeds maxHeight, otherwise hide
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);
}

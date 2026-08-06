/**
 * InteractionPromptSlot — a render target for permission / askUser / plan
 * cards lifted out of a narrow chat rail.
 *
 * Drop one of these anywhere in your route layout where there's enough
 * horizontal room to host a 914-wide card. While mounted, any
 * `<InteractionPromptHost>` elsewhere on screen will portal its cards in
 * here rather than render them inline.
 *
 * Visual: the slot itself is invisible (no border, no bg). Cards bring
 * their own chrome. The slot does set sensible inner constraints:
 * `max-w-[914px] mx-auto px-4` so cards don't smash into the host edges.
 *
 * Lifecycle: registers on mount, deregisters on unmount.
 *   - Don't mount more than one at a time (single-slot policy in store.ts).
 */

import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
import { setSlotElement } from './store';

export interface InteractionPromptSlotProps {
  className?: string;
}

export function InteractionPromptSlot({ className }: InteractionPromptSlotProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSlotElement(ref.current);
    return () => {
      setSlotElement(null);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        // 内层把卡片居中并限制最大宽度 — 卡片本身 max-w-[914px] w-full,
        // 这里再套一层 max-w 是为了 host 区比 914 还宽时 (大屏) 不要把卡片
        // 撑成 100%。 px-4 给卡片和容器边留呼吸。
        'mx-auto w-full max-w-[914px] px-4',
        className,
      )}
    />
  );
}

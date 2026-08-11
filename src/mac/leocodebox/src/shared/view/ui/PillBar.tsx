import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

type PillBarProps = { children: ReactNode; className?: string };

export function PillBar({ children, className }: PillBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ x: 0, width: 0, visible: false });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const update = () => {
      const active = root.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!active) return setIndicator((current) => ({ ...current, visible: false }));
      setIndicator({ x: active.offsetLeft, width: active.offsetWidth, visible: true });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    for (const button of root.querySelectorAll('button')) observer.observe(button);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div ref={rootRef} className={cn('relative inline-flex items-center gap-[2px] rounded-lg bg-muted/60 p-[3px]', className)}>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-[3px] top-[3px] rounded-md bg-background shadow-elevation-2 transition-[transform,width,opacity] duration-base ease-out"
        style={{ width: indicator.width, transform: `translateX(${indicator.x}px)`, opacity: indicator.visible ? 1 : 0 }}
      />
      {children}
    </div>
  );
}

type PillProps = { isActive: boolean; onClick: () => void; children: ReactNode; className?: string };

export function Pill({ isActive, onClick, children, className }: PillProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={isActive}
      className={cn(
        'relative z-[1] flex touch-manipulation items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium leocodebox-motion-fast transition-colors',
        isActive ? 'text-foreground' : 'text-muted-foreground active:bg-background/50',
        className,
      )}
    >
      {children}
    </button>
  );
}

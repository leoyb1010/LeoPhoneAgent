import { Pause, Timer } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface AutomationTimerIconProps {
  size?: number;
  paused?: boolean;
  activeForeground?: boolean;
  running?: boolean;
  className?: string;
}

/**
 * 自动任务的统一视觉标识。
 *
 * 主图标始终使用 Timer，并固定在 12px 槽内。暂停只叠加右下角状态角标，
 * 不弱化或替换主图标、不改变 flex 占位，与手机版保持同一状态表达。
 */
export function AutomationTimerIcon({
  size = 10,
  paused = false,
  activeForeground = false,
  running = false,
  className,
}: AutomationTimerIconProps) {
  const isActivelyRunning = running && !paused;

  return (
    <span
      data-automation-timer-icon="true"
      aria-hidden
      className={cn(
        'relative inline-flex size-3 shrink-0 items-center justify-center',
        isActivelyRunning
          ? 'text-[var(--status-bar-accent)]'
          : activeForeground
            ? 'text-[var(--sidebar-item-active-foreground)]'
            : 'text-[var(--cmd-palette-item-meta)] hover:text-foreground transition-colors',
        isActivelyRunning && 'session-status-breathing',
        className,
      )}
    >
      <Timer size={size} strokeWidth={1.75} className="shrink-0" />
      {paused && (
        <span
          data-automation-paused-indicator="true"
          className={cn(
            'absolute -right-0.5 -bottom-0.5 flex size-2 items-center justify-center rounded-full',
            activeForeground
              ? 'border border-[var(--sidebar-item-active-border)] bg-sidebar-item-active text-[var(--sidebar-item-active-foreground)]'
              : 'border border-[var(--cmd-palette-border)] bg-[var(--chat-input-chip-bg)] text-[var(--cmd-palette-item-meta)]',
          )}
        >
          <Pause size={5} strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

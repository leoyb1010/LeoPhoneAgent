import { cn } from '../../../../lib/utils';

export type ToolStatus = 'running' | 'completed' | 'error' | 'denied';

const STATUS_CONFIG: Record<ToolStatus, { label: string; className: string }> = {
  running: {
    label: 'Running',
    className: 'bg-info/15 text-info dark:bg-info/25 dark:text-info',
  },
  completed: {
    label: 'Completed',
    className: 'bg-success/15 text-success dark:bg-success/25 dark:text-success',
  },
  error: {
    label: 'Error',
    className: 'bg-destructive text-destructive dark:bg-destructive/30 dark:text-destructive',
  },
  denied: {
    label: 'Denied',
    className: 'bg-warning/15 text-warning dark:bg-warning/25 dark:text-warning',
  },
};

interface ToolStatusBadgeProps {
  status: ToolStatus;
  className?: string;
}

export function ToolStatusBadge({ status, className }: ToolStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-px text-[10px] font-medium',
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  );
}

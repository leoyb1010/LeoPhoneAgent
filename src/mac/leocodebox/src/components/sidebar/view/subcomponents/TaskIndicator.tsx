import { AlertCircle, CheckCircle, Settings, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../../../lib/utils';

type TaskIndicatorStatus =
  | 'fully-configured'
  | 'taskmaster-only'
  | 'mcp-only'
  | 'not-configured'
  | 'error';

type TaskIndicatorSize = 'xs' | 'sm' | 'md' | 'lg';

type TaskIndicatorProps = {
  status?: TaskIndicatorStatus;
  size?: TaskIndicatorSize;
  className?: string;
  showLabel?: boolean;
};

type IndicatorConfig = {
  icon: LucideIcon;
  colorClassName: string;
  backgroundClassName: string;
  label: string;
  title: string;
};

const sizeClassNames: Record<TaskIndicatorSize, string> = {
  xs: 'w-3 h-3',
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
};

const paddingClassNames: Record<TaskIndicatorSize, string> = {
  xs: 'p-0.5',
  sm: 'p-1',
  md: 'p-1.5',
  lg: 'p-2',
};

const getIndicatorConfig = (status: TaskIndicatorStatus): IndicatorConfig => {
  // Keep color and label mapping centralized so status display remains consistent in sidebar UIs.
  if (status === 'fully-configured') {
    return {
      icon: CheckCircle,
      colorClassName: 'text-success dark:text-success',
      backgroundClassName: 'bg-success dark:bg-success',
      label: 'TaskMaster Ready',
      title: 'TaskMaster fully configured with MCP server',
    };
  }

  if (status === 'taskmaster-only') {
    return {
      icon: Settings,
      colorClassName: 'text-info dark:text-info',
      backgroundClassName: 'bg-info dark:bg-info',
      label: 'TaskMaster Init',
      title: 'TaskMaster initialized, MCP server needs setup',
    };
  }

  if (status === 'mcp-only') {
    return {
      icon: AlertCircle,
      colorClassName: 'text-warning dark:text-warning',
      backgroundClassName: 'bg-warning dark:bg-warning',
      label: 'MCP Ready',
      title: 'MCP server configured, TaskMaster needs initialization',
    };
  }

  return {
    icon: X,
    colorClassName: 'text-muted-foreground dark:text-muted-foreground',
    backgroundClassName: 'bg-muted dark:bg-muted',
    label: 'No TaskMaster',
    title: 'TaskMaster not configured',
  };
};

export default function TaskIndicator({
  status = 'not-configured',
  size = 'sm',
  className = '',
  showLabel = false,
}: TaskIndicatorProps) {
  const indicatorConfig = getIndicatorConfig(status);
  const Icon = indicatorConfig.icon;

  if (showLabel) {
    return (
      <div
        className={cn(
          'inline-flex items-center gap-1.5 text-xs rounded-md px-2 py-1 transition-colors',
          indicatorConfig.backgroundClassName,
          indicatorConfig.colorClassName,
          className,
        )}
        title={indicatorConfig.title}
      >
        <Icon className={sizeClassNames[size]} />
        <span className="font-normal">{indicatorConfig.label}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'inline-flex items-center justify-center rounded-full transition-colors',
        indicatorConfig.backgroundClassName,
        paddingClassNames[size],
        className,
      )}
      title={indicatorConfig.title}
    >
      <Icon className={cn(sizeClassNames[size], indicatorConfig.colorClassName)} />
    </div>
  );
}

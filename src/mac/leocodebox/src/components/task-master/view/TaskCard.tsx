import { memo } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  ChevronUp,
  Circle,
  Clock,
  Minus,
  Pause,
  X,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import { Tooltip } from '../../../shared/view/ui';
import type { TaskMasterTask } from '../types';

type TaskCardProps = {
  task: TaskMasterTask;
  onClick?: (() => void) | null;
  showParent?: boolean;
  className?: string;
};

type TaskStatusStyle = {
  icon: typeof Circle;
  statusText: string;
  iconColor: string;
  textColor: string;
};

function getStatusStyle(status?: string): TaskStatusStyle {
  if (status === 'done') {
    return {
      icon: CheckCircle,
      statusText: 'Done',
      iconColor: 'text-success dark:text-success',
      textColor: 'text-success dark:text-success',
    };
  }

  if (status === 'in-progress') {
    return {
      icon: Clock,
      statusText: 'In Progress',
      iconColor: 'text-info dark:text-info',
      textColor: 'text-info dark:text-info',
    };
  }

  if (status === 'review') {
    return {
      icon: AlertCircle,
      statusText: 'Review',
      iconColor: 'text-warning dark:text-warning',
      textColor: 'text-warning dark:text-warning',
    };
  }

  if (status === 'deferred') {
    return {
      icon: Pause,
      statusText: 'Deferred',
      iconColor: 'text-muted-foreground dark:text-muted-foreground',
      textColor: 'text-muted-foreground dark:text-muted-foreground',
    };
  }

  if (status === 'cancelled') {
    return {
      icon: X,
      statusText: 'Cancelled',
      iconColor: 'text-destructive dark:text-destructive',
      textColor: 'text-destructive dark:text-destructive',
    };
  }

  return {
    icon: Circle,
    statusText: 'Pending',
    iconColor: 'text-muted-foreground dark:text-muted-foreground',
    textColor: 'text-muted-foreground dark:text-muted-foreground',
  };
}

function renderPriorityIcon(priority?: string) {
  if (priority === 'high') {
    return (
      <Tooltip content="High priority">
        <div className="flex h-4 w-4 items-center justify-center rounded-md bg-destructive dark:bg-destructive/30">
          <ChevronUp className="h-2.5 w-2.5 text-destructive dark:text-destructive" />
        </div>
      </Tooltip>
    );
  }

  if (priority === 'medium') {
    return (
      <Tooltip content="Medium priority">
        <div className="flex h-4 w-4 items-center justify-center rounded-md bg-warning dark:bg-warning/30">
          <Minus className="h-2.5 w-2.5 text-warning dark:text-warning" />
        </div>
      </Tooltip>
    );
  }

  if (priority === 'low') {
    return (
      <Tooltip content="Low priority">
        <div className="flex h-4 w-4 items-center justify-center rounded-md bg-info dark:bg-info/30">
          <Circle className="h-1.5 w-1.5 fill-current text-info dark:text-info" />
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip content="No priority set">
      <div className="flex h-4 w-4 items-center justify-center rounded-md bg-muted dark:bg-muted">
        <Circle className="h-1.5 w-1.5 text-muted-foreground dark:text-muted-foreground" />
      </div>
    </Tooltip>
  );
}

function getSubtaskProgress(task: TaskMasterTask): { completed: number; total: number; percentage: number } {
  const subtasks = task.subtasks ?? [];
  const total = subtasks.length;
  const completed = subtasks.filter((subtask) => subtask.status === 'done').length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { completed, total, percentage };
}

function TaskCard({ task, onClick = null, showParent = false, className = '' }: TaskCardProps) {
  const statusStyle = getStatusStyle(task.status);
  const progress = getSubtaskProgress(task);

  return (
    <div
      className={cn(
        'bg-card dark:bg-muted rounded-lg border border-border dark:border-border p-3 space-y-3',
        'hover:shadow-elevation-2 hover:border-info dark:hover:border-info transition-all duration-base',
        onClick ? 'cursor-pointer hover:-translate-y-0.5' : 'cursor-default',
        className,
      )}
      onClick={onClick ?? undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <Tooltip content={`Task ID: ${task.id}`}>
              <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground dark:bg-muted dark:text-muted-foreground">
                {task.id}
              </span>
            </Tooltip>
          </div>

          <h3 className="line-clamp-2 text-sm font-medium leading-tight text-muted-foreground dark:text-primary-foreground">
            {task.title}
          </h3>

          {showParent && task.parentId && (
            <span className="text-xs font-medium text-muted-foreground dark:text-muted-foreground">Task {task.parentId}</span>
          )}
        </div>

        <div className="flex-shrink-0">{renderPriorityIcon(task.priority)}</div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center">
          {Array.isArray(task.dependencies) && task.dependencies.length > 0 && (
            <Tooltip content={`Depends on: ${task.dependencies.map((dependency) => `Task ${dependency}`).join(', ')}`}>
              <div className="flex items-center gap-1 text-xs text-warning dark:text-warning">
                <ArrowRight className="h-3 w-3" />
                <span>Depends on: {task.dependencies.join(', ')}</span>
              </div>
            </Tooltip>
          )}
        </div>

        <Tooltip content={`Status: ${statusStyle.statusText}`}>
          <div className="flex items-center gap-1">
            <div className={cn('w-2 h-2 rounded-full', statusStyle.iconColor.replace('text-', 'bg-'))} />
            <span className={cn('text-xs font-medium', statusStyle.textColor)}>{statusStyle.statusText}</span>
          </div>
        </Tooltip>
      </div>

      {progress.total > 0 && (
        <div className="ml-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs text-muted-foreground dark:text-muted-foreground">Progress:</span>
            <div className="h-1.5 flex-1 rounded-full bg-muted dark:bg-muted" title={`${progress.completed} of ${progress.total} subtasks completed`}>
              <div
                className={cn('h-full rounded-full transition-all duration-slow', task.status === 'done' ? 'bg-success' : 'bg-info')}
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground dark:text-muted-foreground">
              {progress.completed}/{progress.total}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(TaskCard);

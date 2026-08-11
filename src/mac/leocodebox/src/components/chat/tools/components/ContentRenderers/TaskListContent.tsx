import React from 'react';

interface TaskItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  blockedBy?: string[];
}

interface TaskListContentProps {
  content: string;
}

function parseTaskContent(content: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    // Match patterns like: #15. [in_progress] Subject here
    // or: - #15 [in_progress] Subject (owner: agent)
    // or: #15. Subject here (status: in_progress)
    const match = line.match(/#(\d+)\.?\s*(?:\[(\w+)\]\s*)?(.+?)(?:\s*\((?:owner:\s*\w+)?\))?$/);
    if (match) {
      const [, id, status, subject] = match;
      const blockedMatch = line.match(/blockedBy:\s*\[([^\]]*)\]/);
      tasks.push({
        id,
        subject: subject.trim(),
        status: (status as TaskItem['status']) || 'pending',
        blockedBy: blockedMatch ? blockedMatch[1].split(',').map(s => s.trim()).filter(Boolean) : undefined
      });
    }
  }

  return tasks;
}

const statusConfig = {
  completed: {
    icon: (
      <svg className="h-3.5 w-3.5 text-success dark:text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    textClass: 'line-through text-muted-foreground dark:text-muted-foreground',
    badgeClass: 'bg-success dark:bg-success/30 text-success dark:text-success border-success dark:border-success'
  },
  in_progress: {
    icon: (
      <svg className="h-3.5 w-3.5 text-info dark:text-info" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    textClass: 'text-muted-foreground dark:text-muted-foreground',
    badgeClass: 'bg-info dark:bg-info/30 text-info dark:text-info border-info dark:border-info'
  },
  pending: {
    icon: (
      <svg className="h-3.5 w-3.5 text-muted-foreground dark:text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" strokeWidth={2} />
      </svg>
    ),
    textClass: 'text-muted-foreground dark:text-muted-foreground',
    badgeClass: 'bg-muted dark:bg-muted text-muted-foreground dark:text-muted-foreground border-border dark:border-border'
  }
};

/**
 * Renders task list results with proper status icons and compact layout
 * Parses text content from TaskList/TaskGet results
 */
export const TaskListContent: React.FC<TaskListContentProps> = ({ content }) => {
  const tasks = parseTaskContent(content);

  // If we couldn't parse any tasks, fall back to text display
  if (tasks.length === 0) {
    return (
      <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground dark:text-muted-foreground">
        {content}
      </pre>
    );
  }

  const completed = tasks.filter(t => t.status === 'completed').length;
  const total = tasks.length;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground dark:text-muted-foreground">
          {completed}/{total} completed
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted dark:bg-muted">
          <div
            className="h-full rounded-full bg-success transition-all dark:bg-success"
            style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
          />
        </div>
      </div>
      <div className="space-y-px">
        {tasks.map((task) => {
          const config = statusConfig[task.status] || statusConfig.pending;
          return (
            <div
              key={task.id}
              className="group flex items-center gap-1.5 py-0.5"
            >
              <span className="flex-shrink-0">{config.icon}</span>
              <span className="flex-shrink-0 font-mono text-[11px] text-muted-foreground dark:text-muted-foreground">
                #{task.id}
              </span>
              <span className={`flex-1 truncate text-xs ${config.textClass}`}>
                {task.subject}
              </span>
              <span className={`flex-shrink-0 rounded-md border px-1 py-px text-[10px] ${config.badgeClass}`}>
                {task.status.replace('_', ' ')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

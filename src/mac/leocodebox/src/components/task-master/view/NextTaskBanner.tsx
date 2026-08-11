import { useState } from 'react';
import {
  CheckCircle,
  Circle,
  Eye,
  Flag,
  List,
  Play,
  Settings,
  Target,
  Terminal,
  Zap,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import { useTaskMaster } from '../context/TaskMasterContext';

import TaskDetailModal from './TaskDetailModal';
import TaskMasterSetupModal from './modals/TaskMasterSetupModal';

type NextTaskBannerProps = {
  onShowAllTasks?: (() => void) | null;
  onStartTask?: (() => void) | null;
  className?: string;
};

function PriorityIndicator({ priority }: { priority?: string }) {
  if (priority === 'high') {
    return (
      <div className="flex h-4 w-4 items-center justify-center rounded-md bg-destructive dark:bg-destructive/50" title="High Priority">
        <Zap className="h-2.5 w-2.5 text-destructive dark:text-destructive" />
      </div>
    );
  }

  if (priority === 'medium') {
    return (
      <div className="flex h-4 w-4 items-center justify-center rounded-md bg-warning dark:bg-warning/50" title="Medium Priority">
        <Flag className="h-2.5 w-2.5 text-warning dark:text-warning" />
      </div>
    );
  }

  return (
    <div className="flex h-4 w-4 items-center justify-center rounded-md bg-muted dark:bg-muted" title="Low Priority">
      <Circle className="h-2.5 w-2.5 text-muted-foreground dark:text-muted-foreground" />
    </div>
  );
}

export default function NextTaskBanner({ onShowAllTasks = null, onStartTask = null, className = '' }: NextTaskBannerProps) {
  const {
    nextTask,
    tasks,
    currentProject,
    isLoadingTasks,
    projectTaskMaster,
    refreshTasks,
    refreshProjects,
    setCurrentProject,
  } = useTaskMaster();

  const [showTaskDetail, setShowTaskDetail] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [showSetupDetails, setShowSetupDetails] = useState(false);

  if (!currentProject || isLoadingTasks) {
    return null;
  }

  const hasTasks = Array.isArray(tasks) && tasks.length > 0;
  const hasTaskMaster = Boolean(projectTaskMaster?.hasTaskmaster || currentProject.taskmaster?.hasTaskmaster);

  const handleSetupRefresh = () => {
    void refreshProjects();
    setCurrentProject(currentProject);
    void refreshTasks();
  };

  if (!hasTasks && !hasTaskMaster) {
    return (
      <>
        <div className={cn('bg-info dark:bg-info border border-info dark:border-info rounded-lg p-3 mb-4', className)}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <List className="h-4 w-4 text-info dark:text-info" />
              <p className="text-sm font-medium text-muted-foreground dark:text-primary-foreground">TaskMaster AI is not configured</p>
            </div>

            <button
              onClick={() => setShowSetupModal(true)}
              className="flex items-center gap-1 rounded-md bg-info px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-info"
            >
              <Terminal className="h-3 w-3" />
              Initialize
            </button>
          </div>

          <button
            onClick={() => setShowSetupDetails((current) => !current)}
            className="mt-2 flex items-center gap-1 text-xs text-info hover:underline dark:text-info"
          >
            <Settings className="h-3 w-3" />
            {showSetupDetails ? 'Hide details' : 'What is TaskMaster?'}
          </button>

          {showSetupDetails && (
            <div className="mt-3 space-y-1 text-xs text-info dark:text-info">
              <p>- AI-powered task management with dependencies and subtasks.</p>
              <p>- PRD-driven task generation for faster project bootstrapping.</p>
              <p>- Kanban and list views for day-to-day execution.</p>
            </div>
          )}
        </div>

        <TaskMasterSetupModal
          isOpen={showSetupModal}
          project={currentProject}
          onClose={() => setShowSetupModal(false)}
          onAfterClose={handleSetupRefresh}
        />
      </>
    );
  }

  if (nextTask) {
    return (
      <>
        <div className={cn('bg-muted dark:bg-muted/30 border border-border dark:border-border rounded-lg p-3 mb-4', className)}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-info dark:bg-info/50">
                  <Target className="h-3 w-3 text-info dark:text-info" />
                </div>
                <span className="text-xs font-medium text-muted-foreground dark:text-muted-foreground">Task {nextTask.id}</span>
                <PriorityIndicator priority={nextTask.priority} />
              </div>
              <p className="line-clamp-1 text-sm font-medium text-muted-foreground dark:text-muted-foreground">{nextTask.title}</p>
            </div>

            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                onClick={() => onStartTask?.()}
                className="flex items-center gap-1 rounded-md bg-info px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-info"
              >
                <Play className="h-3 w-3" />
                Start Task
              </button>

              <button
                onClick={() => setShowTaskDetail(true)}
                className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted dark:border-border dark:text-muted-foreground dark:hover:bg-muted"
                title="View task details"
              >
                <Eye className="h-3 w-3" />
              </button>

              {onShowAllTasks && (
                <button
                  onClick={onShowAllTasks}
                  className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted dark:border-border dark:text-muted-foreground dark:hover:bg-muted"
                  title="View all tasks"
                >
                  <List className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </div>

        <TaskDetailModal
          task={nextTask}
          isOpen={showTaskDetail}
          onClose={() => setShowTaskDetail(false)}
          onStatusChange={() => {
            void refreshTasks();
          }}
        />
      </>
    );
  }

  if (hasTasks) {
    const completedTasks = tasks.filter((task) => task.status === 'done').length;

    return (
      <div className={cn('bg-purple-50 dark:bg-purple-950 border border-purple-200 dark:border-purple-800 rounded-lg p-3 mb-4', className)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            <span className="text-sm font-medium text-muted-foreground dark:text-primary-foreground">
              {completedTasks === tasks.length ? 'All tasks complete' : 'No pending tasks'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground dark:text-muted-foreground">
              {completedTasks}/{tasks.length}
            </span>
            {onShowAllTasks && (
              <button
                onClick={onShowAllTasks}
                className="rounded-md bg-purple-600 px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-purple-700"
              >
                Review
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

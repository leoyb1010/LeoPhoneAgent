import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  Edit,
  Loader2,
  Pause,
  Play,
  Save,
  X,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { apiClient } from '../../../utils/apiClient';
import { useTaskMaster } from '../context/TaskMasterContext';
import type { TaskId, TaskMasterTask, TaskReference } from '../types';
import type { AgentProfile, ApiResponse as AgentProfileResponse } from '../../agent-hub/types';
import type { LLMProvider } from '../../../types/app';

type TaskDetailModalProps = {
  task: TaskMasterTask | null;
  isOpen?: boolean;
  className?: string;
  onClose: () => void;
  onEdit?: ((task: TaskMasterTask) => void) | null;
  onStatusChange?: ((taskId: TaskId, status: string) => void) | null;
  onTaskClick?: ((task: TaskReference) => void) | null;
};

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
  { value: 'deferred', label: 'Deferred' },
  { value: 'cancelled', label: 'Cancelled' },
];

function getStatusIcon(status?: string) {
  if (status === 'done') return CheckCircle;
  if (status === 'in-progress') return Clock;
  if (status === 'review') return AlertCircle;
  if (status === 'deferred') return Pause;
  if (status === 'cancelled') return X;
  return Circle;
}

function getPriorityBadgeClass(priority?: string): string {
  if (priority === 'high') return 'text-destructive dark:text-destructive bg-destructive dark:bg-destructive';
  if (priority === 'medium') return 'text-warning dark:text-warning bg-warning dark:bg-warning';
  if (priority === 'low') return 'text-info dark:text-info bg-info dark:bg-info';
  return 'text-muted-foreground dark:text-muted-foreground bg-muted dark:bg-muted';
}

export default function TaskDetailModal({
  task,
  isOpen = true,
  className = '',
  onClose,
  onEdit = null,
  onStatusChange = null,
  onTaskClick = null,
}: TaskDetailModalProps) {
  const { currentProject, refreshTasks } = useTaskMaster();

  const [isEditMode, setIsEditMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showTestStrategy, setShowTestStrategy] = useState(false);
  const [editableTask, setEditableTask] = useState<TaskMasterTask | null>(task);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider>('claude');
  const [isDispatching, setIsDispatching] = useState(false);

  useEffect(() => {
    setEditableTask(task);
    setIsEditMode(false);
  }, [task]);

  useEffect(() => {
    let cancelled = false;
    void apiClient.get<AgentProfileResponse<{ profiles: AgentProfile[] }>>('/api/agent-profiles')
      .then((response) => { if (!cancelled) setAgentProfiles(response.data?.profiles ?? []); })
      .catch(() => { if (!cancelled) setAgentProfiles([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const profile = agentProfiles.find((item) => item.id === selectedProfileId);
    if (profile) setSelectedProvider(profile.provider);
  }, [agentProfiles, selectedProfileId]);

  const StatusIcon = useMemo(() => getStatusIcon(task?.status), [task?.status]);

  if (!isOpen || !task || !editableTask) {
    return null;
  }

  const handleDispatchToAgent = async () => {
    if (!currentProject?.path) return;
    const profile = agentProfiles.find((item) => item.id === selectedProfileId);
    const prompt = [
      profile?.openingPrompt?.trim() || '',
      `Implement TaskMaster task ${task.id}: ${task.title}`,
      task.description?.trim() ? `\n\nDescription:\n${task.description.trim()}` : '',
      task.details?.trim() ? `\n\nImplementation details:\n${task.details.trim()}` : '',
      task.testStrategy?.trim() ? `\n\nTest strategy:\n${task.testStrategy.trim()}` : '',
      '\n\nWhen complete, run the relevant verification and report the changed files and results.',
    ].filter(Boolean).join('\n\n');

    setIsDispatching(true);
    try {
      await apiClient.put(
        `/api/taskmaster/update-task/${encodeURIComponent(currentProject.projectId)}/${encodeURIComponent(String(task.id))}`,
        { status: 'in-progress' },
      );
      const result = await apiClient.post<Record<string, unknown>>('/api/agent', {
        projectPath: currentProject.path,
        message: prompt,
        provider: profile?.provider || selectedProvider,
        model: profile?.model || undefined,
        effort: profile?.effort || undefined,
        permissionMode: profile?.permissionMode || 'acceptEdits',
        stream: false,
        cleanup: false,
      });
      const bindings = JSON.parse(localStorage.getItem('taskmaster-agent-bindings') || '{}') as Record<string, unknown>;
      bindings[`${currentProject.projectId}:${task.id}`] = {
        provider: profile?.provider || selectedProvider,
        profileId: profile?.id || null,
        completedAt: new Date().toISOString(),
        result,
      };
      localStorage.setItem('taskmaster-agent-bindings', JSON.stringify(bindings));
      await apiClient.put(
        `/api/taskmaster/update-task/${encodeURIComponent(currentProject.projectId)}/${encodeURIComponent(String(task.id))}`,
        { status: 'done' },
      );
      await refreshTasks();
      onStatusChange?.(task.id, 'done');
      onClose();
    } catch (error) {
      await apiClient.put(
        `/api/taskmaster/update-task/${encodeURIComponent(currentProject.projectId)}/${encodeURIComponent(String(task.id))}`,
        { status: 'review' },
      ).catch(() => undefined);
      alert(error instanceof Error ? error.message : 'Agent dispatch failed');
    } finally {
      setIsDispatching(false);
    }
  };

  const handleSaveChanges = async () => {
    if (!currentProject?.projectId) {
      return;
    }

    const updates: Record<string, string> = {};

    if (editableTask.title !== task.title) {
      updates.title = editableTask.title;
    }

    if (editableTask.description !== task.description) {
      updates.description = editableTask.description ?? '';
    }

    if (editableTask.details !== task.details) {
      updates.details = editableTask.details ?? '';
    }

    if (Object.keys(updates).length === 0) {
      setIsEditMode(false);
      return;
    }

    setIsSaving(true);
    try {
      await apiClient.put(
        `/api/taskmaster/update-task/${encodeURIComponent(currentProject.projectId)}/${encodeURIComponent(String(task.id))}`,
        updates,
      );

      setIsEditMode(false);
      await refreshTasks();
      onEdit?.(editableTask);
    } catch (error) {
      console.error('Failed to save task changes:', error);
      alert(error instanceof Error ? error.message : 'Failed to update task');
    } finally {
      setIsSaving(false);
    }
  };

  const handleStatusSelect = async (nextStatus: string) => {
    if (!currentProject?.projectId || nextStatus === task.status) {
      return;
    }

    try {
      await apiClient.put(
        `/api/taskmaster/update-task/${encodeURIComponent(currentProject.projectId)}/${encodeURIComponent(String(task.id))}`,
        { status: nextStatus },
      );

      await refreshTasks();
      onStatusChange?.(task.id, nextStatus);
    } catch (error) {
      console.error('Failed to update task status:', error);
      alert(error instanceof Error ? error.message : 'Failed to update task status');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 md:p-4">
      <div
        className={cn(
          'w-full md:max-w-4xl h-full md:h-[90vh] bg-card dark:bg-muted border border-border dark:border-border md:rounded-lg shadow-elevation-3 flex flex-col',
          className,
        )}
      >
        <div className="flex items-center justify-between border-b border-border p-4 dark:border-border md:p-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <StatusIcon className="h-6 w-6 text-info dark:text-info" />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => copyTextToClipboard(String(task.id))}
                className="mb-2 inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-muted dark:bg-muted dark:text-muted-foreground dark:hover:bg-muted"
                title="Copy task ID"
                aria-label="Copy task ID"
              >
                <span>Task {task.id}</span>
                <Copy className="h-3 w-3" />
              </button>

              {isEditMode ? (
                <input
                  type="text"
                  value={editableTask.title}
                  onChange={(event) => setEditableTask({ ...editableTask, title: event.target.value })}
                  className="w-full border-b-2 border-info bg-transparent text-lg font-semibold text-muted-foreground focus:outline-none dark:text-primary-foreground"
                />
              ) : (
                <h1 className="line-clamp-2 text-lg font-semibold text-muted-foreground dark:text-primary-foreground md:text-xl">{task.title}</h1>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isEditMode && (
              <button
                type="button"
                onClick={() => void handleDispatchToAgent()}
                disabled={isDispatching}
                className="rounded-md p-2 text-primary hover:bg-primary/10"
                title="Dispatch to agent"
                aria-label="Dispatch task to agent"
              >
                {isDispatching ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />}
              </button>
            )}
            {isEditMode ? (
              <>
                <button
                  type="button"
                  onClick={handleSaveChanges}
                  disabled={isSaving}
                  className="rounded-md p-2 text-success hover:bg-success disabled:opacity-50 dark:hover:bg-success"
                  title="Save"
                  aria-label="Save task"
                >
                  <Save className={cn('w-5 h-5', isSaving && 'animate-spin')} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditableTask(task);
                    setIsEditMode(false);
                  }}
                  disabled={isSaving}
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted dark:hover:bg-muted"
                  title="Cancel editing"
                  aria-label="Cancel editing"
                >
                  <X className="h-5 w-5" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setIsEditMode(true)}
                className="rounded-md p-2 text-muted-foreground hover:bg-muted dark:hover:bg-muted"
                title="Edit task"
                aria-label="Edit task"
              >
                <Edit className="h-5 w-5" />
              </button>
            )}
            <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-muted dark:hover:bg-muted" title="Close" aria-label="Close task details">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="grid gap-2 border-b border-border bg-muted/20 p-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-muted-foreground">Agent profile
            <select className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm" value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
              <option value="">No profile</option>
              {agentProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.emoji} {profile.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">Provider
            <select className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm" value={selectedProvider} disabled={Boolean(selectedProfileId)} onChange={(event) => setSelectedProvider(event.target.value as LLMProvider)}>
              {['claude', 'codex', 'cursor', 'opencode', 'grok'].map((provider) => <option key={provider} value={provider}>{provider}</option>)}
            </select>
          </label>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-4 md:p-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground dark:text-muted-foreground">Status</label>
              <select
                value={task.status ?? 'pending'}
                onChange={(event) => {
                  void handleStatusSelect(event.target.value);
                }}
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-muted-foreground dark:border-border dark:bg-muted dark:text-primary-foreground"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground dark:text-muted-foreground">Priority</label>
              <div className={cn('px-3 py-2 rounded-md text-sm font-medium capitalize', getPriorityBadgeClass(task.priority))}>
                {task.priority ?? 'Not set'}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground dark:text-muted-foreground">Dependencies</label>
              {Array.isArray(task.dependencies) && task.dependencies.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {task.dependencies.map((dependency) => (
                    <button
                      type="button"
                      key={String(dependency)}
                      onClick={() => onTaskClick?.({ id: dependency })}
                      className="rounded-md bg-info px-2 py-1 text-sm text-info hover:bg-info dark:bg-info/25 dark:text-info dark:hover:bg-info"
                    >
                      <ArrowRight className="mr-1 inline h-3 w-3" />
                      {dependency}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground dark:text-muted-foreground">No dependencies</span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground dark:text-muted-foreground">Description</label>
            {isEditMode ? (
              <textarea
                rows={4}
                value={editableTask.description ?? ''}
                onChange={(event) => setEditableTask({ ...editableTask, description: event.target.value })}
                className="w-full rounded-md border border-border bg-card px-3 py-2 dark:border-border dark:bg-muted"
              />
            ) : (
              <p className="whitespace-pre-wrap text-muted-foreground dark:text-muted-foreground">{task.description || 'No description provided'}</p>
            )}
          </div>

          {task.details && (
            <div className="rounded-lg border border-border dark:border-border">
              <button
                type="button"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((current) => !current)}
                className="flex w-full items-center justify-between p-4 text-left hover:bg-muted dark:hover:bg-muted"
              >
                <span className="text-sm font-medium text-muted-foreground dark:text-muted-foreground">Implementation Details</span>
                {showDetails ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {showDetails && (
                <div className="border-t border-border p-4 dark:border-border">
                  <p className="whitespace-pre-wrap text-muted-foreground dark:text-muted-foreground">{task.details}</p>
                </div>
              )}
            </div>
          )}

          {task.testStrategy && (
            <div className="rounded-lg border border-border dark:border-border">
              <button
                type="button"
                aria-expanded={showTestStrategy}
                onClick={() => setShowTestStrategy((current) => !current)}
                className="flex w-full items-center justify-between p-4 text-left hover:bg-muted dark:hover:bg-muted"
              >
                <span className="text-sm font-medium text-muted-foreground dark:text-muted-foreground">Test Strategy</span>
                {showTestStrategy ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {showTestStrategy && (
                <div className="border-t border-border bg-info p-4 dark:border-border dark:bg-info/30">
                  <p className="whitespace-pre-wrap text-muted-foreground dark:text-muted-foreground">{task.testStrategy}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

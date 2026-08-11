import { useState } from 'react';
import { Plus, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import Shell from '../../../shell/view/Shell';
import type { TaskMasterProject } from '../../types';

type TaskMasterSetupModalProps = {
  isOpen: boolean;
  project: TaskMasterProject | null;
  onClose: () => void;
  onAfterClose?: (() => void) | null;
};

export default function TaskMasterSetupModal({ isOpen, project, onClose, onAfterClose = null }: TaskMasterSetupModalProps) {
  const { t } = useTranslation('tasks');
  const [isTaskMasterComplete, setIsTaskMasterComplete] = useState(false);

  if (!isOpen || !project) {
    return null;
  }

  const closeModal = () => {
    onClose();
    setIsTaskMasterComplete(false);

    // Delay refresh slightly so the CLI has time to flush writes to disk.
    window.setTimeout(() => {
      onAfterClose?.();
    }, 800);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-16 backdrop-blur-sm">
      <div className="flex h-[600px] w-full max-w-4xl flex-col rounded-lg border border-border bg-card shadow-elevation-3 dark:border-border dark:bg-muted">
        <div className="flex items-center justify-between border-b border-border p-4 dark:border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-info dark:bg-info/50">
              <Terminal className="h-4 w-4 text-info dark:text-info" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-muted-foreground dark:text-primary-foreground">{t('setupModal.title')}</h2>
              <p className="text-sm text-muted-foreground dark:text-muted-foreground">{t('setupModal.subtitle', { projectName: project.displayName })}</p>
            </div>
          </div>

          <button
            onClick={closeModal}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted dark:hover:text-muted-foreground"
            title="Close"
          >
            <Plus className="h-5 w-5 rotate-45" />
          </button>
        </div>

        <div className="flex-1 p-4">
          <div className="h-full overflow-hidden rounded-lg bg-black">
            <Shell
              selectedProject={project}
              selectedSession={null}
              initialCommand="npx task-master init"
              isPlainShell
              isActive
              onProcessComplete={(exitCode) => {
                if (exitCode === 0) {
                  setIsTaskMasterComplete(true);
                }
              }}
            />
          </div>
        </div>

        <div className="border-t border-border bg-muted p-4 dark:border-border dark:bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground dark:text-muted-foreground">
              {isTaskMasterComplete ? (
                <span className="flex items-center gap-2 text-success dark:text-success">
                  <span className="h-2 w-2 rounded-full bg-success" />
                  {t('setupModal.completed')}
                </span>
              ) : (
                t('setupModal.willStart')
              )}
            </div>

            <button
              onClick={closeModal}
              className={cn(
                'px-4 py-2 text-sm font-medium rounded-md transition-colors',
                isTaskMasterComplete
                  ? 'bg-success hover:bg-success text-primary-foreground'
                  : 'text-muted-foreground dark:text-muted-foreground bg-card dark:bg-muted border border-border dark:border-border hover:bg-muted dark:hover:bg-muted',
              )}
            >
              {isTaskMasterComplete ? t('setupModal.closeContinueButton') : t('setupModal.closeButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

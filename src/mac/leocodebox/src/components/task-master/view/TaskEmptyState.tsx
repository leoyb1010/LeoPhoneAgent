import { FileText, Settings, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import type { PrdFile } from '../types';

type TaskEmptyStateProps = {
  className?: string;
  hasTaskMasterDirectory: boolean;
  existingPrds: PrdFile[];
  onOpenSetupModal: () => void;
  onCreatePrd: () => void;
  onOpenPrd: (prd: PrdFile) => void;
};

export default function TaskEmptyState({
  className = '',
  hasTaskMasterDirectory,
  existingPrds,
  onOpenSetupModal,
  onCreatePrd,
  onOpenPrd,
}: TaskEmptyStateProps) {
  const { t } = useTranslation('tasks');

  if (!hasTaskMasterDirectory) {
    return (
      <div className={cn('text-center py-12', className)}>
        <div className="mx-auto max-w-md">
          <div className="mb-4 text-info dark:text-info">
            <Settings className="mx-auto mb-4 h-12 w-12" />
          </div>

          <h3 className="mb-2 text-lg font-semibold text-muted-foreground dark:text-primary-foreground">{t('notConfigured.title')}</h3>
          <p className="mb-6 text-sm text-muted-foreground dark:text-muted-foreground">{t('notConfigured.description')}</p>

          <div className="mb-6 rounded-lg bg-info p-4 text-left dark:bg-info">
            <h4 className="mb-3 text-sm font-medium text-info dark:text-info">{t('notConfigured.whatIsTitle')}</h4>
            <div className="space-y-1 text-xs text-info dark:text-info">
              <p>- {t('notConfigured.features.aiPowered')}</p>
              <p>- {t('notConfigured.features.prdTemplates')}</p>
              <p>- {t('notConfigured.features.dependencyTracking')}</p>
              <p>- {t('notConfigured.features.progressVisualization')}</p>
              <p>- {t('notConfigured.features.cliIntegration')}</p>
            </div>
          </div>

          <button
            onClick={onOpenSetupModal}
            className="mx-auto flex items-center gap-2 rounded-lg bg-info px-4 py-2 font-medium text-primary-foreground transition-colors hover:bg-info"
          >
            <Terminal className="h-4 w-4" />
            {t('notConfigured.initializeButton')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('text-center py-12', className)}>
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 rounded-xl border border-info bg-gradient-to-r from-blue-50 to-indigo-50 p-6 text-left dark:border-info dark:from-blue-950/50 dark:to-indigo-950/50">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info dark:bg-info/50">
              <FileText className="h-5 w-5 text-info dark:text-info" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-muted-foreground dark:text-primary-foreground">{t('gettingStarted.title')}</h2>
              <p className="text-sm text-muted-foreground dark:text-muted-foreground">{t('gettingStarted.subtitle')}</p>
            </div>
          </div>

          <div className="mb-4 space-y-3">
            <div className="rounded-lg border border-info bg-card p-3 dark:border-info/50 dark:bg-muted/60">
              <h4 className="mb-1 font-medium text-muted-foreground dark:text-primary-foreground">1. {t('gettingStarted.steps.createPRD.title')}</h4>
              <p className="mb-3 text-sm text-muted-foreground dark:text-muted-foreground">{t('gettingStarted.steps.createPRD.description')}</p>

              <button
                onClick={onCreatePrd}
                className="inline-flex items-center gap-2 rounded-md bg-purple-100 px-2 py-1 text-xs text-purple-700 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:hover:bg-purple-900/50"
              >
                <FileText className="h-3 w-3" />
                {t('gettingStarted.steps.createPRD.addButton')}
              </button>

              {existingPrds.length > 0 && (
                <div className="mt-3 border-t border-border pt-3 dark:border-border">
                  <p className="mb-2 text-xs text-muted-foreground dark:text-muted-foreground">{t('gettingStarted.steps.createPRD.existingPRDs')}</p>
                  <div className="flex flex-wrap gap-2">
                    {existingPrds.map((prd) => (
                      <button
                        key={prd.name}
                        onClick={() => onOpenPrd(prd)}
                        className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-muted dark:bg-muted dark:text-muted-foreground dark:hover:bg-muted"
                      >
                        <FileText className="h-3 w-3" />
                        {prd.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-info bg-card p-3 dark:border-info/50 dark:bg-muted/60">
              <h4 className="mb-1 font-medium text-muted-foreground dark:text-primary-foreground">2. {t('gettingStarted.steps.generateTasks.title')}</h4>
              <p className="text-sm text-muted-foreground dark:text-muted-foreground">{t('gettingStarted.steps.generateTasks.description')}</p>
            </div>

            <div className="rounded-lg border border-info bg-card p-3 dark:border-info/50 dark:bg-muted/60">
              <h4 className="mb-1 font-medium text-muted-foreground dark:text-primary-foreground">3. {t('gettingStarted.steps.analyzeTasks.title')}</h4>
              <p className="text-sm text-muted-foreground dark:text-muted-foreground">{t('gettingStarted.steps.analyzeTasks.description')}</p>
            </div>

            <div className="rounded-lg border border-info bg-card p-3 dark:border-info/50 dark:bg-muted/60">
              <h4 className="mb-1 font-medium text-muted-foreground dark:text-primary-foreground">4. {t('gettingStarted.steps.startBuilding.title')}</h4>
              <p className="text-sm text-muted-foreground dark:text-muted-foreground">{t('gettingStarted.steps.startBuilding.description')}</p>
            </div>
          </div>

          <button
            onClick={onCreatePrd}
            className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 font-medium text-primary-foreground hover:bg-purple-700"
          >
            <FileText className="h-4 w-4" />
            {t('buttons.addPRD')}
          </button>
        </div>

        <p className="text-sm text-muted-foreground dark:text-muted-foreground">{t('gettingStarted.tip')}</p>
      </div>
    </div>
  );
}

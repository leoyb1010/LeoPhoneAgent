import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';

export function ProjectAutomationNotifyBridge() {
  const { t } = useTranslation();

  useEffect(() => {
    return window.electronAPI.maker.projectAutomation.onEvent((event: ProjectAutomationEvent) => {
      if (event.type !== 'reconciled') return;
      if (!event.hashChanged) return;
      const { inserted, updated, deleted, isFirstTime, workingDir } = event;
      if (inserted + updated + deleted === 0) return;

      const projectName = lastPathSegment(workingDir);
      const summary = t('scheduler.projectAutomation.toast.summary', {
        inserted,
        updated,
        deleted,
      });
      if (isFirstTime) {
        toast.success(t('scheduler.projectAutomation.toast.installed', { projectName, summary }));
      } else {
        toast.success(t('scheduler.projectAutomation.toast.updated', { projectName, summary }));
      }
    });
  }, [t]);

  return null;
}

function lastPathSegment(input: string): string {
  return input.split(/[\\/]/).filter(Boolean).pop() ?? input;
}

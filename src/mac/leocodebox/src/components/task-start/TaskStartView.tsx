import { ArrowRight, FolderOpen, Library } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';

type TaskStartViewProps = {
  project: Project | null;
  onOpenLibrary: () => void;
};

/** Context for the single Task Dock; never a second prompt or submission. */
export default function TaskStartView({ project, onOpenLibrary }: TaskStartViewProps) {
  const { t } = useTranslation();
  return (
    <main className="flex h-full min-h-0 justify-center overflow-y-auto px-6 py-8">
      <section className="w-full max-w-[760px]" aria-labelledby="task-start-title">
        <h1 id="task-start-title" className="text-balance text-2xl font-semibold leading-snug tracking-tight text-foreground">
          {t('taskStart.title')}
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{t('taskStart.description')}</p>
        <p className="mt-2 text-xs leading-6 text-wb-faint">{t('taskStart.examples')}</p>

        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('leocodebox:open-projects'))}
          className="mt-6 flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={project ? t('taskStart.changeProject') : t('workbench.pickProject')}
        >
          <FolderOpen className="h-4 w-4 flex-none text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t('taskStart.projectLabel')}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{project?.fullPath || project?.path || t('taskStart.noProject')}</p>
          </div>
          <ArrowRight className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
        </button>

        <button type="button" onClick={onOpenLibrary} className="mt-4 flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          <Library className="h-4 w-4 flex-none text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t('taskStart.libraryTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('taskStart.libraryDescription')}</p>
          </div>
          <ArrowRight className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
        </button>
        <p className="mt-6 text-xs text-wb-faint">{t('taskStart.shortcuts')}</p>
      </section>
    </main>
  );
}

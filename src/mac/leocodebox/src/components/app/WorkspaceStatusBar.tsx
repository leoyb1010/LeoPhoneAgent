import { Cpu, HardDrive, Route, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import { useLeoapiStatus } from '../../hooks/useLeoapiStatus';
import { useVersionCheck } from '../../hooks/useVersionCheck';

import { resolveUpdateBadge } from './updateBadge';
import DoctorHealthLight from './DoctorHealthLight';

type WorkspaceStatusBarProps = {
  selectedProject: Project | null;
  runningCount: number;
  /** Chat provider of the current session, used to pick the matching Leoapi target. */
  activeProvider?: string | null;
};

export default function WorkspaceStatusBar({ selectedProject, runningCount, activeProvider }: WorkspaceStatusBarProps) {
  const { t } = useTranslation();
  const leoapiNodes = useLeoapiStatus();
  const { updateAvailable, restartRequired, latestVersion } = useVersionCheck();
  const updateBadge = resolveUpdateBadge(updateAvailable, restartRequired);
  // cursor-agent sessions map onto the `cursor` config target; the rest match by id.
  const targetId = activeProvider === 'cursor-agent' ? 'cursor' : activeProvider;
  const activeNode = targetId ? leoapiNodes[targetId] : null;
  return (
    <footer className="leocodebox-status-bar hidden h-7 flex-shrink-0 items-center justify-between border-t border-border px-3 text-[10px] text-muted-foreground md:flex">
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-success dark:text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {t('workspaceShell.serviceHealthy')}
        </span>
        {selectedProject && (
          <span className="max-w-[42vw] truncate font-mono" title={selectedProject.fullPath}>
            {selectedProject.fullPath}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {updateBadge.show && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('leocodebox:open-version-modal'))}
            className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
            title={updateBadge.tone === 'update'
              ? t('workspaceShell.updateReady', { version: latestVersion ?? '' })
              : t('workspaceShell.restartRequired')}
          >
            <span
              className={`h-1.5 w-1.5 animate-pulse rounded-full ${updateBadge.tone === 'update' ? 'bg-info' : 'bg-warning'}`}
            />
            {updateBadge.tone === 'update'
              ? t('workspaceShell.updateReady', { version: latestVersion ?? '' })
              : t('workspaceShell.restartRequired')}
          </button>
        )}
        {activeNode && (
          <span
            className="inline-flex items-center gap-1 text-primary"
            title={t('workspaceShell.leoapiNodeHint', { node: activeNode.name })}
          >
            <Route className="h-3 w-3" />
            {activeNode.name}
            {activeNode.latencyMs !== null && ` · ${activeNode.latencyMs}ms`}
          </span>
        )}
        <DoctorHealthLight />
        <span className="inline-flex items-center gap-1"><Cpu className="h-3 w-3" />{runningCount > 0 ? t('workspaceShell.tasksRunning', { count: runningCount }) : t('workspaceShell.agentIdle')}</span>
        <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3" />{t('workspaceShell.localOnly')}</span>
        <span className="inline-flex items-center gap-1"><HardDrive className="h-3 w-3" />{t('workspaceShell.autoSave')}</span>
      </div>
    </footer>
  );
}

import { Cpu, Route, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import { useLeoapiStatus } from '../../hooks/useLeoapiStatus';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import QuotaPopover from '../workbench/QuotaPopover';

import { resolveUpdateBadge } from './updateBadge';
import DoctorHealthLight from './DoctorHealthLight';

type WorkspaceStatusBarProps = {
  selectedProject: Project | null;
  runningCount: number;
  /** Chat provider of the current session, used to pick the matching Leoapi target. */
  activeProvider?: string | null;
  /** Opens the local-log popover. The rail that used to host this entry is gone. */
  onOpenLocalLog?: () => void;
};

/**
 * 30px 状态栏 —— 工作台唯一的常驻信息带。
 *
 * 它同时接手了原来 DesktopAppRail 底部的「本地日志」入口:导航栏删掉之后,
 * 日志不该只能从命令面板找到,状态栏是它最自然的家。
 */
export default function WorkspaceStatusBar({
  selectedProject,
  runningCount,
  activeProvider,
  onOpenLocalLog,
}: WorkspaceStatusBarProps) {
  const { t } = useTranslation();
  const leoapiNodes = useLeoapiStatus();
  const { updateAvailable, restartRequired, latestVersion, currentVersion } = useVersionCheck();
  const updateBadge = resolveUpdateBadge(updateAvailable, restartRequired);
  // cursor-agent sessions map onto the `cursor` config target; the rest match by id.
  const targetId = activeProvider === 'cursor-agent' ? 'cursor' : activeProvider;
  const activeNode = targetId ? leoapiNodes[targetId] : null;
  return (
    <footer className="leocodebox-status-bar relative z-20 hidden h-[30px] flex-shrink-0 items-center justify-between border-t border-border px-5 font-mono text-[9.5px] text-wb-faint md:flex">
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
        <QuotaPopover />
        <DoctorHealthLight />
        <span className="inline-flex items-center gap-1"><Cpu className="h-3 w-3" />{runningCount > 0 ? t('workspaceShell.tasksRunning', { count: runningCount }) : t('workspaceShell.agentIdle')}</span>
        <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3" />{t('workspaceShell.localOnly')}</span>
        {onOpenLocalLog && (
          <button
            type="button"
            onClick={onOpenLocalLog}
            className="border-b border-dotted border-current transition-colors hover:text-muted-foreground"
          >
            {t('workspaceShell.localLog')}
          </button>
        )}
        <span>leocodebox {currentVersion ?? ''}</span>
      </div>
    </footer>
  );
}

import { Clock3, Cpu, FolderLock, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession } from '../../../../types/app';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

type WorkspaceRunInspectorProps = {
  project: Project;
  session: ProjectSession | null;
  activity: SessionActivity;
  runningCount: number;
};

export default function WorkspaceRunInspector({
  project,
  session,
  activity,
  runningCount,
}: WorkspaceRunInspectorProps) {
  const { t } = useTranslation();
  const provider = session?.__provider ?? session?.provider ?? 'codex';
  const providerLabel = provider === 'claude'
    ? 'Claude Code'
    : provider === 'opencode'
      ? 'OpenCode'
      : provider === 'cursor'
        ? 'Cursor'
        : 'Codex';

  return (
    <aside className="leocodebox-run-inspector hidden w-60 flex-shrink-0 flex-col border-l border-border bg-card/35 xl:flex">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[11px] font-medium text-muted-foreground">{t('workspaceRuntime.currentRun')}</div>
        <div className="mt-2 flex items-center gap-2">
          <SessionProviderLogo provider={provider} className="h-5 w-5" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">{providerLabel}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />{t('workspaceRuntime.running')}
            </div>
          </div>
        </div>
      </div>

      <div className="divide-y divide-border/70 text-xs">
        <div className="space-y-2.5 px-4 py-3">
          <div className="flex items-center gap-2 text-muted-foreground"><Cpu className="h-3.5 w-3.5" />{t('workspaceRuntime.localTasks', { count: runningCount })}</div>
          <div className="flex items-center gap-2 text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{activity.statusText || t('workspaceRuntime.processing')}</div>
          <div className="flex items-center gap-2 text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" />{t('workspaceRuntime.localPermissions')}</div>
        </div>
        <div className="px-4 py-3">
          <div className="mb-2 text-[11px] font-medium text-muted-foreground">{t('workspaceRuntime.workingDirectory')}</div>
          <div className="flex items-start gap-2 rounded-md bg-muted/45 px-2.5 py-2 font-mono text-[10px] leading-4 text-foreground">
            <FolderLock className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-all">{project.fullPath}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

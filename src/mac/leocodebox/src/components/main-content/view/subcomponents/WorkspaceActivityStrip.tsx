import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, Clock3, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import type { ProjectSession } from '../../../../types/app';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

type WorkspaceActivityStripProps = {
  session: ProjectSession | null;
  activity: SessionActivity | null;
};

const formatElapsed = (startedAt: number, now: number) => {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

export default function WorkspaceActivityStrip({ session, activity }: WorkspaceActivityStripProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activity) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activity]);

  const provider = session?.__provider ?? session?.provider ?? 'codex';
  const providerLabel = useMemo(() => {
    if (provider === 'claude') return 'Claude Code';
    if (provider === 'cursor') return 'Cursor';
    if (provider === 'opencode') return 'OpenCode';
    return 'Codex';
  }, [provider]);

  if (!activity) return null;

  return (
    <div className="leocodebox-activity-strip relative flex h-10 flex-shrink-0 items-center gap-3 border-b border-border/70 px-4 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <SessionProviderLogo provider={provider} className="h-4 w-4" />
        <span className="font-medium text-foreground">{providerLabel}</span>
        <span className="inline-flex items-center gap-1 text-primary">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          {t('workspaceRuntime.running')}
        </span>
      </div>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {activity.statusText || t('workspaceRuntime.processingCurrent')}
      </span>
      <span className="hidden items-center gap-1.5 text-muted-foreground sm:inline-flex">
        <Clock3 className="h-3 w-3" />{formatElapsed(activity.startedAt, now)}
      </span>
      <span className="hidden items-center gap-1.5 text-muted-foreground lg:inline-flex">
        <ShieldCheck className="h-3 w-3" />{t('workspaceRuntime.localExecution')}
      </span>
      <CircleCheck className="h-3.5 w-3.5 text-muted-foreground/50" />
      <div className="leocodebox-activity-trace absolute inset-x-0 bottom-0 h-px bg-primary/20" />
    </div>
  );
}

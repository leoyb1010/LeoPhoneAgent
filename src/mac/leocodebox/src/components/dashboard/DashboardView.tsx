import { useCallback, useMemo, useState } from 'react';

import { useDashboardData } from '../../hooks/useDashboardData';

import AgentGridCard from './cards/AgentGridCard';
import DashboardHero from './cards/DashboardHero';
import GatewayCard from './cards/GatewayCard';
import KernelCard from './cards/KernelCard';
import MissionSummaryCard from './cards/MissionSummaryCard';
import ProjectsOverviewCard from './cards/ProjectsOverviewCard';
import QuickActionsBar from './cards/QuickActionsBar';
import RunningSessionsCard from './cards/RunningSessionsCard';
import UsageCenterCard from './cards/UsageCenterCard';

type DashboardViewProps = {
  onNavigateToSession?: (sessionId: string) => void;
  onShowTab?: (tab: string) => void;
  onNewChat?: () => void;
  onShowSettings?: () => void;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The dashboard landing view: a 3-column responsive grid. Left = agent grid +
 * projects, middle = live sessions + missions, right = usage centre. Rich
 * hero on top, quick actions along the bottom. Cards stagger their entrance.
 */
export default function DashboardView({ onNavigateToSession, onShowTab, onNewChat, onShowSettings }: DashboardViewProps) {
  const data = useDashboardData();
  const [runningCount, setRunningCount] = useState(0);

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      if (sessionId) {
        onNavigateToSession?.(sessionId);
      } else {
        onNewChat?.();
      }
    },
    [onNavigateToSession, onNewChat],
  );

  const handleOpenMissions = useCallback(() => onShowTab?.('missions'), [onShowTab]);
  const handleOpenProjects = useCallback(() => onShowTab?.('files'), [onShowTab]);
  const handleRunDoctor = useCallback(() => {
    window.dispatchEvent(new CustomEvent('leocodebox:open-doctor'));
  }, []);

  // Today's headline metrics for the hero.
  const heroMetrics = useMemo(() => {
    const today = todayIso();
    const todayRows = (data.usage.data ?? []).filter((row) => row.day === today);
    return {
      sessionsToday: todayRows.reduce((sum, row) => sum + (row.sessionCount || 0), 0),
      tokensToday: todayRows.reduce((sum, row) => sum + (row.inputTokens || 0) + (row.outputTokens || 0) + (row.cacheTokens || 0), 0),
      costTodayUsd: todayRows.reduce((sum, row) => sum + (row.costUsd || 0), 0),
      runningNow: runningCount,
    };
  }, [data.usage.data, runningCount]);

  const handleRunningCount = useCallback((count: number) => setRunningCount(count), []);

  const readyAgents = useMemo(
    () => Object.values(data.providerAuth.data ?? {}).filter((provider) => provider.authenticated).length,
    [data.providerAuth.data],
  );

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-[1320px] space-y-4 px-5 py-5 lg:px-8 lg:py-7">
        <DashboardHero
          username={data.authUser.data?.username ?? 'local-user'}
          metrics={heroMetrics}
          readyAgents={readyAgents}
          projectCount={data.projects.data?.length ?? 0}
          onRefresh={data.refresh}
          onNewChat={() => onNewChat?.()}
          onShowFleet={() => onShowTab?.('fleet')}
          onShowMissions={handleOpenMissions}
          onShowSettings={() => onShowSettings?.()}
        />

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          <div className="flex flex-col gap-3 lg:col-span-7">
            <RunningSessionsCard onOpenSession={handleOpenSession} onCountChange={handleRunningCount} delay={40} />
            <MissionSummaryCard
              missions={data.missions.data}
              loading={data.missions.loading}
              error={data.missions.error}
              onOpenMissions={handleOpenMissions}
              onRetry={data.refresh}
              delay={80}
            />
          </div>

          <div className="flex flex-col gap-3 lg:col-span-5">
            <AgentGridCard
              cliTools={data.cliTools.data}
              providerAuth={data.providerAuth.data}
              loading={data.cliTools.loading || data.providerAuth.loading}
              error={data.cliTools.error ?? data.providerAuth.error}
              onRefresh={data.refresh}
              delay={120}
            />
            <ProjectsOverviewCard
              projects={data.projects.data}
              loading={data.projects.loading}
              error={data.projects.error}
              onOpenProjects={handleOpenProjects}
              onRetry={data.refresh}
              delay={160}
            />
          </div>
        </div>

        <details className="group rounded-xl border border-border bg-card shadow-elevation-1">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground">
            <span>工程与用量详情</span>
            <span className="text-xs font-normal text-muted-foreground group-open:hidden">需要时展开，不打扰日常任务</span>
            <span className="hidden text-xs font-normal text-muted-foreground group-open:inline">收起详情</span>
          </summary>
          <div className="grid grid-cols-1 gap-3 border-t border-border p-3 lg:grid-cols-3">
            <UsageCenterCard
              usage={data.usage.data}
              quota={data.quota.data}
              quotaLoading={data.quota.loading}
              loading={data.usage.loading}
              error={data.usage.error}
              onRefresh={data.refresh}
              delay={0}
            />
            <GatewayCard delay={0} />
            <KernelCard delay={0} />
          </div>
        </details>

        <QuickActionsBar onRunDoctor={handleRunDoctor} delay={200} />
      </div>
    </div>
  );
}

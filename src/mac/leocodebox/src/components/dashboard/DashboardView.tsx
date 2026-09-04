import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDashboardData } from '../../hooks/useDashboardData';
import { useAppPreferences } from '../../contexts/PreferencesContext';
import { useLocalAgents } from '../workbench/useLocalAgents';
import { useFleetSnapshot } from '../workbench/useFleetSnapshot';

import type { ConsoleMachineOption, NewTaskLaunch } from './newTask';
import AgentGridCard from './cards/AgentGridCard';
import CodexHostCard from './cards/CodexHostCard';
import NewTaskCard from './cards/NewTaskCard';
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
  onShowSettings: (tab?: string) => void;
  /** 外壳当前选中的项目,作为「新任务」目录的初始值。 */
  selectedProjectId?: string | null;
  /** 主控台发起新任务 —— 选中的 Agent 显式随请求下发,见 newTask.ts。 */
  onStartTask?: (launch: NewTaskLaunch) => void;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 主控台 —— 工作台的落地页,也是**换 Agent 唯一不产生歧义的地方**。
 *
 * 1.68 把这一页删掉("对话即首页"),结果所有 Agent 切换都被迫发生在某个
 * 已经绑定了 Agent 的会话内部:代码只能猜用户是想改这个会话、还是想开新的,
 * 猜错就是三轮没修干净的「选了 Codex,发出去还是 Claude」。请回这一页不是
 * 为了把仪表盘画回来,而是为了给「选 Agent + 开新任务」一个还没有会话的落点
 * —— 那就是最上面的 NewTaskCard,其余卡片仍然只是状态陈列。
 *
 * 对话优先的外壳(标题栏 / 会话列表 / 指挥条)一并保留:从这里点进任意会话,
 * 进去之后还是现在那套会话界面。
 */
export default function DashboardView({
  onNavigateToSession,
  onShowTab,
  onNewChat,
  onShowSettings,
  selectedProjectId = null,
  onStartTask,
}: DashboardViewProps) {
  const { t } = useTranslation();
  const data = useDashboardData();
  const { preferences } = useAppPreferences();
  // Agent / 远程机器都复用指挥条那两个数据源,不另起一份事实。
  const { agents: localAgents } = useLocalAgents();
  const { remotes, localName } = useFleetSnapshot();
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

  const machineOptions = useMemo<ConsoleMachineOption[]>(
    () => [{
      name: null as string | null,
      label: localName || t('dashboard.newTaskLocal', { defaultValue: '本机' }),
      desc: t('dashboard.newTaskLocalDesc', { defaultValue: '这台 Mac' }),
    }].concat(
      // 离线机器不进菜单,免得任务打进黑洞。
      remotes
        .filter((machine) => machine.online && machine.reachable)
        .map((machine) => ({
          name: machine.name,
          label: machine.name,
          desc: machine.activeCount > 0
            ? t('workbench.remoteActive', { count: machine.activeCount, defaultValue: `${machine.activeCount} 个会话运行中` })
            : t('dashboard.newTaskRemoteIdle', { defaultValue: '空闲 · 经中继下发' }),
        })),
    ),
    [localName, remotes, t],
  );

  const projectOptions = useMemo(
    () => (data.projects.data ?? []).map((project) => ({
      projectId: project.projectId,
      displayName: project.displayName,
      path: project.path || project.fullPath,
    })),
    [data.projects.data],
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
      runningNow: runningCount,
    };
  }, [data.usage.data, runningCount]);

  const handleRunningCount = useCallback((count: number) => setRunningCount(count), []);

  const readyAgents = useMemo(
    () => Object.values(data.providerAuth.data ?? {}).filter((provider) => provider.authenticated).length,
    [data.providerAuth.data],
  );
  const codexHost = useMemo(
    () => data.cliTools.data?.find((tool) => tool.id === 'codexhost') ?? null,
    [data.cliTools.data],
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
          onShowFleet={() => onShowTab?.('fleet')}
          onShowSettings={() => onShowSettings()}
        />

        {onStartTask && (
          <NewTaskCard
            agents={localAgents.map((agent) => ({
              provider: agent.provider,
              label: agent.label,
              status: agent.status,
              disabled: !agent.installed,
            }))}
            machines={machineOptions}
            projects={projectOptions}
            defaultProvider={preferences.defaultProvider}
            selectedProjectId={selectedProjectId}
            onStartTask={onStartTask}
            onOpenAgentSettings={() => onShowSettings('agents')}
            onOpenProjects={() => window.dispatchEvent(new CustomEvent('leocodebox:open-projects'))}
            delay={20}
          />
        )}

        <CodexHostCard
          tool={codexHost}
          loading={data.cliTools.loading}
          onOpenSettings={() => onShowSettings('agents')}
          delay={35}
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
            <span>本机日志</span>
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

import {
  ArrowRight,
  CheckCircle2,
  CircleGauge,
  Command,
  ListChecks,
  MessageSquare,
  MonitorCog,
  RefreshCw,
  Settings2,
  Smartphone,
} from 'lucide-react';

import { useDoctorReport } from '../../../hooks/useDoctorReport';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { resolveDoctorTone, type DoctorTone } from '../../app/doctorLight';

const TONE_DOT: Record<DoctorTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  fail: 'bg-destructive',
};

type HeroMetrics = {
  sessionsToday: number;
  tokensToday: number;
  costTodayUsd: number;
  runningNow: number;
};

type DashboardHeroProps = {
  username: string;
  metrics: HeroMetrics;
  readyAgents: number;
  projectCount: number;
  onRefresh: () => void;
  onNewChat: () => void;
  onShowFleet: () => void;
  onShowMissions: () => void;
  onShowSettings: () => void;
};

type RouteCardProps = {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
};

function RouteCard({ icon, title, description, onClick }: RouteCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="leo-squish group flex min-h-[76px] items-center gap-3 rounded-xl border border-border/80 bg-background/70 px-4 py-3 text-left hover:-translate-y-0.5 hover:border-primary/35 hover:bg-card hover:shadow-elevation-1"
    >
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </button>
  );
}

export default function DashboardHero({
  username,
  metrics,
  readyAgents,
  projectCount,
  onRefresh,
  onNewChat,
  onShowFleet,
  onShowMissions,
  onShowSettings,
}: DashboardHeroProps) {
  const report = useDoctorReport();
  const { currentVersion } = useVersionCheck();
  const tone = resolveDoctorTone(report?.summary);
  const healthLabel = !report?.summary
    ? '检查本机能力中'
    : report.summary.fail > 0
      ? `${report.summary.fail} 项需要处理`
      : report.summary.warn > 0
        ? `${report.summary.warn} 项提醒`
        : '本机能力就绪';

  return (
    <section className="dash-enter overflow-hidden rounded-[22px] border border-border bg-card text-card-foreground shadow-elevation-2" style={{ ['--dash-delay' as string]: '0ms' }}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/logo-32.png" alt="leocodebox" className="h-10 w-10 rounded-xl shadow-elevation-1" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-tight text-foreground">leocodebox</p>
            <p className="text-xs text-muted-foreground">Mac 本机开发与执行中心</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground sm:inline-flex">
            <Smartphone className="h-3.5 w-3.5 text-primary" />
            可被 iPhone 主动选作执行目标
          </span>
          <button
            type="button"
            onClick={onShowSettings}
            aria-label="打开设置"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="刷新状态"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)] lg:px-6 lg:py-7">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Leo 的 Mac 开发工作台</p>
          <h1 className="mt-3 max-w-[720px] text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground lg:text-[38px] lg:leading-[1.12]">
            在这台 Mac 上编排、执行和接管开发任务
          </h1>
          <p className="mt-3 max-w-[680px] text-sm leading-6 text-muted-foreground lg:text-[15px]">
            leocodebox 可以独立调用本机 Codex、Claude Code 与项目工具。iPhone 同样独立工作；只有你主动选择某台 Mac 时，任务才会经中继交到这里持续执行。
          </p>

          <div className="mt-5 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={onNewChat}
              className="leo-squish inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-elevation-1 hover:-translate-y-0.5 hover:shadow-elevation-2"
            >
              <MessageSquare className="h-4 w-4" />
              在本机开始任务
            </button>
            <button
              type="button"
              onClick={onShowFleet}
              className="leo-squish inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-accent"
            >
              <MonitorCog className="h-4 w-4 text-primary" />
              查看三台 Mac
            </button>
          </div>

          <div className="mt-6 grid gap-2.5 md:grid-cols-3">
            <RouteCard
              icon={<MessageSquare className="h-5 w-5" />}
              title="本机对话与执行"
              description="选项目、选 Agent，在这台 Mac 开始"
              onClick={onNewChat}
            />
            <RouteCard
              icon={<MonitorCog className="h-5 w-5" />}
              title="三台 Mac"
              description="查看跨机任务与处理待审批操作"
              onClick={onShowFleet}
            />
            <RouteCard
              icon={<ListChecks className="h-5 w-5" />}
              title="快速任务"
              description="把重复工作变成一键流程"
              onClick={onShowMissions}
            />
          </div>
        </div>

        <aside className="rounded-xl border border-border bg-background/80 p-4 lg:p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">当前状态</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{metrics.runningNow > 0 ? `${metrics.runningNow} 个任务正在运行` : '可以开始新任务'}</p>
            </div>
            <span className={`mt-1 h-2.5 w-2.5 rounded-full ${TONE_DOT[tone]} ${tone === 'ok' ? 'dash-dot-glow' : 'animate-pulse'}`} />
          </div>

          <div className="mt-5 space-y-3">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-success" />可用 Agent</span>
              <strong className="text-sm font-semibold text-foreground">{readyAgents} 个</strong>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground"><Command className="h-4 w-4 text-primary" />本机项目</span>
              <strong className="text-sm font-semibold text-foreground">{projectCount} 个</strong>
            </div>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('leocodebox:open-doctor'))}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="flex items-center gap-2"><CircleGauge className="h-4 w-4 text-primary" />{healthLabel}</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 rounded-xl bg-secondary/70 px-3 py-3 text-xs leading-5 text-muted-foreground">
            <span className="font-medium text-foreground">{username}</span>
            <span className="mx-1.5">·</span>
            <span>v{currentVersion}</span>
            <span className="mx-1.5">·</span>
            <span>{metrics.sessionsToday} 个今日会话</span>
          </div>
        </aside>
      </div>
    </section>
  );
}

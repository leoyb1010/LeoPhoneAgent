import {
  ArrowRight,
  CheckCircle2,
  CircleGauge,
  Command,
  MessageSquare,
  MonitorCog,
} from 'lucide-react';

import { useDoctorReport } from '../../../hooks/useDoctorReport';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { resolveDoctorTone, type DoctorTone } from '../../app/doctorLight';

import DashboardHeaderActions from './DashboardHeaderActions';

const TONE_DOT: Record<DoctorTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  fail: 'bg-destructive',
};

type HeroMetrics = {
  sessionsToday: number;
  runningNow: number;
};

type DashboardHeroProps = {
  username: string;
  metrics: HeroMetrics;
  readyAgents: number;
  projectCount: number;
  onRefresh: () => Promise<{ ok: boolean }>;
  onNewChat: () => void;
  onShowFleet: () => void;
  onShowSettings: () => void;
};

type MetricProps = {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  onClick?: () => void;
  className?: string;
};

function Metric({ icon, label, value, onClick, className = '' }: MetricProps) {
  const content = (
    <>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/[0.08] text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-medium text-muted-foreground">{label}</span>
        <span className="mt-0.5 block truncate text-sm font-semibold text-foreground">{value}</span>
      </span>
      {onClick && <ArrowRight className="ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
    </>
  );

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-w-0 items-center gap-2.5 px-3 py-3 text-left transition-colors hover:bg-accent/45 ${className}`}
    >
      {content}
    </button>
  ) : (
    <div className={`flex min-w-0 items-center gap-2.5 px-3 py-3 ${className}`}>{content}</div>
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
  onShowSettings,
}: DashboardHeroProps) {
  const report = useDoctorReport();
  const { currentVersion } = useVersionCheck();
  const tone = resolveDoctorTone(report?.summary);
  const healthLabel = !report?.summary
    ? '检查中'
    : report.summary.fail > 0
      ? `${report.summary.fail} 项待处理`
      : report.summary.warn > 0
        ? `${report.summary.warn} 项提醒`
        : '全部就绪';
  const headline = metrics.runningNow > 0
    ? `${metrics.runningNow} 个任务正在这台 Mac 上执行`
    : '这台 Mac 已就绪，随时开始任务';

  return (
    <section
      className="dash-enter overflow-hidden rounded-[22px] border border-border bg-card text-card-foreground shadow-elevation-2"
      style={{ ['--dash-delay' as string]: '0ms' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/logo-32.png" alt="LeoPhoneAgent" className="h-9 w-9 rounded-xl shadow-elevation-1" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-tight text-foreground">LeoPhoneAgent · Mac</p>
            <p className="truncate text-[11px] text-muted-foreground">{username} · v{currentVersion} · 本机执行端</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground sm:inline-flex">
            <span className={`h-2 w-2 rounded-full ${TONE_DOT[tone]} ${tone === 'ok' ? 'dash-dot-glow' : 'animate-pulse'}`} />
            {metrics.runningNow > 0 ? '正在执行' : '等待任务'}
          </span>
          <DashboardHeaderActions onShowSettings={onShowSettings} onRefresh={onRefresh} />
        </div>
      </div>

      <div className="px-5 pb-6 pt-6 lg:px-6 lg:pb-7 lg:pt-7">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">本机任务控制中心</p>
        <div className="mt-3 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div className="max-w-[760px]">
            <h1 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground lg:text-[38px] lg:leading-[1.12]">
              {headline}
            </h1>
            <p className="mt-3 max-w-[700px] text-sm leading-6 text-muted-foreground lg:text-[15px]">
              在本机选择项目与 Agent 独立执行，也可以由 iPhone 主动把任务交给这台 Mac；只有你选择时才会建立接管连接。
            </p>
          </div>

          <div className="flex flex-wrap gap-2.5 lg:justify-end">
            <button
              type="button"
              onClick={onNewChat}
              className="leo-squish inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-elevation-1 hover:-translate-y-0.5 hover:shadow-elevation-2"
            >
              <MessageSquare className="h-4 w-4" />
              开始本机任务
            </button>
            <button
              type="button"
              onClick={onShowFleet}
              className="leo-squish inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-accent"
            >
              <MonitorCog className="h-4 w-4 text-primary" />
              三台 Mac
            </button>
          </div>
        </div>

        <div className="mt-6 grid overflow-hidden rounded-xl border border-border/80 bg-background/65 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            icon={<CircleGauge className="h-4 w-4" />}
            label="能力健康"
            value={healthLabel}
            onClick={() => window.dispatchEvent(new CustomEvent('leocodebox:open-doctor'))}
            className="border-b border-border/70 sm:border-r lg:border-b-0"
          />
          <Metric icon={<CheckCircle2 className="h-4 w-4" />} label="可用 Agent" value={`${readyAgents} 个`} className="border-b border-border/70 lg:border-b-0 lg:border-r" />
          <Metric icon={<Command className="h-4 w-4" />} label="本机项目" value={`${projectCount} 个`} className="border-b border-border/70 sm:border-b-0 sm:border-r" />
          <Metric icon={<MessageSquare className="h-4 w-4" />} label="今日会话" value={`${metrics.sessionsToday} 个`} />
        </div>
      </div>
    </section>
  );
}

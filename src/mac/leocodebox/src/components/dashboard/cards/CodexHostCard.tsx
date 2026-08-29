import { useState } from 'react';
import { ArrowUpRight, Check, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../../utils/apiClient';
import type { CliToolStatus } from '../dashboardTypes';

import { DashCard, DashCardTitle, StatusDot } from './dashShared';

const HARNESSES = ['Pi', 'Oh My Pi', 'Claude Code', 'Grok Build', 'DeepSeek Harness'];
const CAPABILITIES = [
  ['stream', 'Streaming'], ['tools', 'Tool status'], ['diff', 'Diff'], ['approval', 'Approvals'],
  ['usage', 'Usage'], ['fork', 'Fork'], ['compact', 'Compaction'],
] as const;

type Props = {
  tool: CliToolStatus | null;
  loading: boolean;
  onOpenSettings: () => void;
  delay?: number;
};

export default function CodexHostCard({ tool, loading, onOpenSettings, delay = 0 }: Props) {
  const { t } = useTranslation();
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const ready = Boolean(tool?.installed && tool?.runnable && tool?.canLaunch);

  const launch = async () => {
    setLaunching(true);
    setMessage(null);
    try {
      const result = await apiClient.post<{ success?: boolean; error?: string }>('/api/leocodebox/cli/codexhost/launch');
      setMessage(result?.success
        ? t('dashboard.codexHostStarted', { defaultValue: 'CodexHost 已启动；LeoAPI 继续在后台工作。' })
        : result?.error || t('dashboard.codexHostFailed', { defaultValue: 'CodexHost 启动失败。' }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('dashboard.codexHostFailed', { defaultValue: 'CodexHost 启动失败。' }));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <DashCard delay={delay} className="p-4">
      <DashCardTitle
        title={t('dashboard.codexHostTitle', { defaultValue: 'CodexHost 工作台' })}
        action={tool?.currentVersion && <span className="font-mono text-[11px] text-muted-foreground">v{tool.currentVersion}</span>}
      />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex items-start gap-2.5">
            <StatusDot tone={loading ? 'idle' : ready ? 'ok' : 'fail'} />
            <div>
              <p className="text-sm font-medium text-foreground">
                {loading
                  ? t('dashboard.codexHostChecking', { defaultValue: '正在检查随包运行时…' })
                  : ready
                    ? t('dashboard.codexHostReady', { defaultValue: '已就绪 · 在 Codex Desktop 中运行原生 Harness' })
                    : t('dashboard.codexHostUnavailable', { defaultValue: '随包运行时不可用，请先修复安装。' })}
              </p>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                {t('dashboard.codexHostDescription', { defaultValue: '沿用 Codex Desktop 的项目、线程、审批和 Diff 体验；LeoAPI、手机中继与本工作台继续独立运行。' })}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="py-1 text-[11px] text-muted-foreground">{t('dashboard.codexHostSupports', { defaultValue: '可接入' })}</span>
            {HARNESSES.map((name) => <span key={name} className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground">{name}</span>)}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {CAPABILITIES.map(([key, fallback]) => <span key={key} className="inline-flex items-center gap-1"><Check className="h-3 w-3 text-success" />{t(`dashboard.codexHostCapability.${key}`, { defaultValue: fallback })}</span>)}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
          <button
            type="button"
            onClick={() => void launch()}
            disabled={!ready || launching}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
            {t('dashboard.codexHostOpen', { defaultValue: '打开 CodexHost' })}
          </button>
          <button type="button" onClick={onOpenSettings} className="min-h-9 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            {t('dashboard.codexHostManage', { defaultValue: '管理本机 Agent' })}
          </button>
        </div>
      </div>
      {message && <p role="status" className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{message}</p>}
    </DashCard>
  );
}

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAnimatedNumber } from '../../../hooks/useAnimatedNumber';
import type { ClaudeQuotaEstimate, UsageSummaryRow } from '../dashboardTypes';
import { formatCny, formatCnyAmount, formatTokensCn, usdToCny } from '../format';

import ClaudeQuotaRings from './ClaudeQuotaRings';
import { DashCard, DashCardTitle, DashEmpty, DashError, DashSkeleton } from './dashShared';

type UsageCenterCardProps = {
  usage: UsageSummaryRow[] | null;
  quota: ClaudeQuotaEstimate | null;
  quotaLoading: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  delay?: number;
};

const MODEL_COLORS = ['bg-success', 'bg-primary', 'bg-info', 'bg-muted-foreground/50', 'bg-warning', 'bg-destructive'];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok Build',
  gemini: 'Gemini CLI',
  hermes: 'Hermes Agent',
};

function shortModelName(model: string | null, provider: string): string {
  if (!model) return PROVIDER_LABEL[provider] ?? provider;
  return model.length > 16 ? `${model.slice(0, 15)}…` : model;
}

export default function UsageCenterCard({ usage, quota, quotaLoading, loading, error, onRefresh, delay = 0 }: UsageCenterCardProps) {
  const { t } = useTranslation();
  const today = todayIso();

  const summary = useMemo(() => {
    const rows = usage ?? [];
    const todayRows = rows.filter((row) => row.day === today);
    const totalSessions = todayRows.reduce((sum, row) => sum + (row.sessionCount || 0), 0);
    const totalTokens = todayRows.reduce((sum, row) => sum + (row.inputTokens || 0) + (row.outputTokens || 0) + (row.cacheTokens || 0), 0);
    const totalCost = todayRows.reduce((sum, row) => sum + (row.costUsd || 0), 0);

    // Per-model breakdown for today, sorted by cost desc.
    const byModel = new Map<string, { label: string; tokens: number; cost: number }>();
    for (const row of todayRows) {
      const key = `${row.provider}::${row.model ?? ''}`;
      const existing = byModel.get(key) ?? { label: shortModelName(row.model, row.provider), tokens: 0, cost: 0 };
      existing.tokens += (row.inputTokens || 0) + (row.outputTokens || 0) + (row.cacheTokens || 0);
      existing.cost += row.costUsd || 0;
      byModel.set(key, existing);
    }
    const models = [...byModel.values()].sort((a, b) => b.cost - a.cost).slice(0, 5);
    const maxModelCost = models[0]?.cost ?? 1;

    // Per-CLI cumulative across the fetched range.
    const byCli = new Map<string, { label: string; tokens: number; cost: number }>();
    for (const row of rows) {
      const existing = byCli.get(row.provider) ?? { label: PROVIDER_LABEL[row.provider] ?? row.provider, tokens: 0, cost: 0 };
      existing.tokens += (row.inputTokens || 0) + (row.outputTokens || 0) + (row.cacheTokens || 0);
      existing.cost += row.costUsd || 0;
      byCli.set(row.provider, existing);
    }
    const clis = [...byCli.values()].sort((a, b) => b.cost - a.cost).slice(0, 4);

    // 7-day cost trend, oldest → newest.
    const byDay = new Map<string, number>();
    for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + (row.costUsd || 0));
    const days: Array<{ day: string; cost: number }> = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push({ day: key, cost: byDay.get(key) ?? 0 });
    }
    const maxDayCost = Math.max(0.0001, ...days.map((d) => d.cost));

    return { totalSessions, totalTokens, totalCost, models, maxModelCost, clis, days, maxDayCost };
  }, [usage, today]);

  const animatedSessions = useAnimatedNumber(summary.totalSessions);
  const animatedCostCny = useAnimatedNumber(usdToCny(summary.totalCost));

  return (
    <DashCard delay={delay} className="dash-card-glow p-4">
      <DashCardTitle
        title={t('dashboard.usageTitle', { defaultValue: '本机日志' })}
        action={<span className="text-[12px] text-muted-foreground">{t('dashboard.today', { defaultValue: '今天' })}</span>}
      />

      {loading ? (
        <DashSkeleton rows={5} />
      ) : error && !usage ? (
        <DashError message={error} onRetry={onRefresh} />
      ) : (
        <div className="space-y-4">
          {/* Today overview — numbers tween toward their targets. */}
          <div className="grid grid-cols-3 gap-2">
            <div className="dash-stat rounded-lg px-2.5 py-2">
              <div className="text-[11px] text-muted-foreground">{t('dashboard.sessions', { defaultValue: '会话' })}</div>
              <div className="text-[18px] font-medium tabular-nums text-foreground">{Math.round(animatedSessions)}</div>
            </div>
            <div className="dash-stat rounded-lg px-2.5 py-2">
              <div className="text-[11px] text-muted-foreground">Tokens</div>
              <div className="text-[18px] font-medium tabular-nums text-foreground">{formatTokensCn(summary.totalTokens)}</div>
            </div>
            <div className="dash-stat rounded-lg px-2.5 py-2">
              <div className="text-[11px] text-muted-foreground">{t('dashboard.cost', { defaultValue: '成本' })}</div>
              <div className="text-[18px] font-medium tabular-nums text-foreground">{formatCnyAmount(animatedCostCny)}</div>
            </div>
          </div>

          {/* Claude window consumption (measured locally). */}
          <ClaudeQuotaRings quota={quota} loading={quotaLoading} />

          {/* Per-model breakdown. */}
          {summary.models.length > 0 && (
            <div>
              <div className="mb-2 text-[12px] text-muted-foreground">{t('dashboard.byModel', { defaultValue: '按模型' })}</div>
              <div className="space-y-2.5">
                {summary.models.map((model, index) => (
                  <div key={model.label}>
                    <div className="mb-1 flex items-center justify-between text-[12px]">
                      <span className="truncate text-foreground">{model.label}</span>
                      <span className="flex-shrink-0 tabular-nums text-muted-foreground">
                        {formatTokensCn(model.tokens)} · {formatCny(model.cost)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className={`dash-bar-fill h-full rounded-full ${MODEL_COLORS[index % MODEL_COLORS.length]}`}
                        style={{ width: `${Math.max(3, (model.cost / summary.maxModelCost) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-CLI cumulative. */}
          {summary.clis.length > 0 && (
            <div>
              <div className="mb-2 text-[12px] text-muted-foreground">{t('dashboard.byCli', { defaultValue: '各 CLI 累计' })}</div>
              <div className="space-y-1.5">
                {summary.clis.map((cli) => (
                  <div key={cli.label} className="flex items-center justify-between text-[12px]">
                    <span className="text-foreground">{cli.label}</span>
                    <span className="tabular-nums text-muted-foreground">{formatTokensCn(cli.tokens)} · {formatCny(cli.cost, { decimals: 1 })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 7-day cost trend. */}
          <div>
            <div className="mb-1.5 text-[12px] text-muted-foreground">{t('dashboard.trend7d', { defaultValue: '近 7 日成本' })}</div>
            <svg viewBox="0 0 280 48" className="block h-12 w-full" role="img" aria-label={t('dashboard.trend7d', { defaultValue: '近 7 日成本' })}>
              {summary.days.map((d, index) => {
                const height = Math.max(2, (d.cost / summary.maxDayCost) * 42);
                const isToday = index === summary.days.length - 1;
                return (
                  <rect
                    key={d.day}
                    x={index * 40 + 4}
                    y={46 - height}
                    width="30"
                    height={height}
                    rx="3"
                    className={`dash-bar-grow ${isToday ? 'fill-success' : index % 2 === 0 ? 'fill-primary/40' : 'fill-primary/60'}`}
                    style={{ transformOrigin: `${index * 40 + 19}px 46px` }}
                  >
                    <title>{`${d.day}: ${formatCny(d.cost)}`}</title>
                  </rect>
                );
              })}
            </svg>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground/70">
              <span>{summary.days[0]?.day.slice(5).replace('-', '/')}</span>
              <span>{t('dashboard.today', { defaultValue: '今天' })}</span>
            </div>
          </div>

          {summary.totalSessions === 0 && summary.models.length === 0 && (
            <DashEmpty message={t('dashboard.usageEmpty', { defaultValue: '今天还没有用量记录' })} />
          )}
        </div>
      )}
    </DashCard>
  );
}

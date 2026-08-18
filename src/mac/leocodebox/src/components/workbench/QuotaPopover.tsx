import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../utils/apiClient';
import { startVisibleInterval } from '../../utils/visibilityInterval';
import { cn } from '../../lib/utils';
import { formatCny, formatCountCn, formatTokensCn } from '../dashboard/format';
import SessionProviderLogo from '../llm-logo-provider/SessionProviderLogo';

import { useLocalAgents } from './useLocalAgents';

type QuotaWindow = { name: string; usedPercent: number; windowMinutes: number; resetsAt: number | null };

type QuotaProvider = {
  id: string;
  label: string;
  authoritative: boolean;
  source: string;
  available: boolean;
  plan?: string | null;
  windows?: QuotaWindow[];
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
  rolling?: { windowHours: number; tokens: number; requests: number } | null;
  note?: string;
};

type GatewayStatus = {
  enabled: boolean;
  meter: { today: { requests: number; inputTokens: number; outputTokens: number; costUsd: number } };
};

const REFRESH_MS = 120_000;

function windowLabel(minutes: number): string {
  if (minutes >= 10080) return `${Math.round(minutes / 10080)} 周`;
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} 天`;
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时`;
  return `${minutes} 分钟`;
}

/** 重置倒计时。到点之前只给到分钟级 —— 秒级跳动在状态栏里是噪音。 */
function resetLabel(resetsAt: number | null, now: number): string {
  if (!resetsAt) return '';
  const seconds = resetsAt - Math.floor(now / 1000);
  if (seconds <= 0) return '已重置';
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天后重置`;
  if (hours >= 1) return `${hours} 小时后重置`;
  return `${Math.max(1, Math.round(seconds / 60))} 分钟后重置`;
}

function meterTone(percent: number): string {
  if (percent >= 90) return 'bg-destructive';
  if (percent >= 70) return 'bg-warning';
  return 'bg-primary';
}

/**
 * [T-quota-bar] 状态栏的 AI 额度浮窗。
 *
 * 借 CodexBar 的思路(不登录每一家、只读本机已有状态),但只吸收对这个工作台
 * 有意义的那部分,并且把"服务端真实额度"和"本机日志累加"在界面上分开标注 ——
 * 把估算值摆成配额是最容易骗到自己的做法。
 */
export default function QuotaPopover() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<QuotaProvider[]>([]);
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const { agents } = useLocalAgents();

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const [quota, gatewayStatus] = await Promise.all([
        apiClient.get<{ providers?: QuotaProvider[] }>(`/api/leocodebox/quota${force ? '?refresh=1' : ''}`),
        apiClient.get<GatewayStatus>('/api/leocodebox/gateway/status').catch(() => null),
      ]);
      setProviders(Array.isArray(quota.providers) ? quota.providers : []);
      if (gatewayStatus) setGateway(gatewayStatus);
      setNow(Date.now());
    } catch {
      // 额度是信息性的,读不到就留着上一次的数字,不清空。
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return startVisibleInterval(() => void load(), REFRESH_MS);
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const onAway = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onAway);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onAway);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 状态栏上的迷你计量条取"最紧张的那个窗口"——一眼看到的应该是最危险的数字。
  const headline = useMemo(() => {
    const windows = providers.flatMap((provider) => (provider.authoritative ? provider.windows ?? [] : []));
    if (windows.length === 0) return null;
    return windows.reduce((worst, window) => (window.usedPercent > worst.usedPercent ? window : worst));
  }, [providers]);

  const today = gateway?.meter?.today;
  const todayTokens = (today?.inputTokens ?? 0) + (today?.outputTokens ?? 0);

  return (
    <div ref={ref} className="relative">
      {/* 状态栏上要一眼认得出这是个可点的额度计。之前只有一条 8px 的细条,
          在 9.5px 的状态栏里等于隐身 —— 现在给足图标 + 文字 + 百分比。 */}
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); setNow(Date.now()); }}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('workbench.quotaTooltip', { defaultValue: 'AI 额度与状态' })}
        aria-label={t('workbench.quotaTooltip', { defaultValue: 'AI 额度与状态' })}
        className={cn(
          'wb-chip-button h-[20px] gap-1.5 rounded-full px-2 font-mono text-[9.5px]',
          open && 'text-foreground',
        )}
      >
        <Gauge className="h-3 w-3" />
        <span>{t('workbench.quotaShort', { defaultValue: 'AI 额度' })}</span>
        {headline && (
          <>
            <span className="h-1 w-7 overflow-hidden rounded-full bg-background">
              <span
                className={cn('block h-full rounded-full transition-[width] duration-slow', meterTone(headline.usedPercent))}
                style={{ width: `${Math.min(100, Math.round(headline.usedPercent))}%` }}
              />
            </span>
            <span className="tabular-nums">{Math.round(headline.usedPercent)}%</span>
          </>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('workbench.quotaTooltip', { defaultValue: 'AI 额度与状态' })}
          className="wb-anim-card absolute bottom-full right-0 z-[70] mb-2 w-[340px] rounded-xl bg-card p-3 font-sans shadow-elevation-3 ring-1 ring-inset ring-border"
        >
          <div className="mb-2 flex items-center gap-2 px-1">
            <span className="text-xs font-bold text-foreground">
              {t('workbench.quotaTitle', { defaultValue: 'AI 额度' })}
            </span>
            <span className="font-mono text-[9px] text-wb-faint">本机采集</span>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
              title={t('workbench.quotaRefresh', { defaultValue: '重新采集' })}
              aria-label={t('workbench.quotaRefresh', { defaultValue: '重新采集' })}
              className="wb-chip-button ml-auto h-[22px] w-[22px]"
            >
              <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {providers.map((provider) => (
              <div key={provider.id} className="rounded-lg bg-muted px-3 py-2.5 ring-1 ring-inset ring-border">
                <div className="flex items-center gap-2">
                  <SessionProviderLogo provider={provider.id} className="h-4 w-4" />
                  <span className="text-[12px] font-semibold text-foreground">{provider.label}</span>
                  {provider.plan && (
                    <span className="rounded-md bg-background px-1.5 py-px font-mono text-[9px] uppercase text-primary">
                      {provider.plan}
                    </span>
                  )}
                  {!provider.authoritative && (
                    <span className="rounded-md bg-background px-1.5 py-px font-mono text-[9px] text-wb-faint">
                      {t('workbench.quotaLocalTally', { defaultValue: '本机统计' })}
                    </span>
                  )}
                </div>

                {!provider.available && (
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-wb-faint">
                    {provider.note || t('workbench.quotaUnavailable', { defaultValue: '本机暂时读不到这家的用量记录。' })}
                  </p>
                )}

                {provider.windows?.map((window) => (
                  <div key={window.name} className="mt-2">
                    <div className="flex justify-between font-mono text-[9.5px] text-wb-faint">
                      <span>{windowLabel(window.windowMinutes)}窗口 · {Math.round(window.usedPercent)}%</span>
                      <span>{resetLabel(window.resetsAt, now)}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-background">
                      <div
                        className={cn('h-full rounded-full transition-[width] duration-slow', meterTone(window.usedPercent))}
                        style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                      />
                    </div>
                  </div>
                ))}

                {provider.rolling && (
                  <p className="mt-1.5 font-mono text-[9.5px] text-wb-faint">
                    近 {provider.rolling.windowHours} 小时 · {formatTokensCn(provider.rolling.tokens)} tokens · {formatCountCn(provider.rolling.requests)} 次
                  </p>
                )}

                {provider.credits?.hasCredits && (
                  <p className="mt-1 font-mono text-[9.5px] text-wb-faint">余额 {provider.credits.balance}</p>
                )}
              </div>
            ))}

            <div className="rounded-lg bg-muted px-3 py-2.5 ring-1 ring-inset ring-border">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-foreground">Leoapi</span>
                <span className={cn('h-1.5 w-1.5 rounded-full', gateway?.enabled ? 'bg-primary' : 'bg-wb-faint')} />
                <span className="font-mono text-[9px] text-wb-faint">
                  {gateway?.enabled
                    ? t('workbench.gatewayRunning', { defaultValue: '网关运行中' })
                    : t('workbench.gatewayOff', { defaultValue: '网关未启用' })}
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[9.5px] text-wb-faint">
                今日 · {formatTokensCn(todayTokens)} tokens · {formatCountCn(today?.requests ?? 0)} 次 · {formatCny(today?.costUsd ?? 0)}
              </p>
            </div>
          </div>

          {/* 读不到额度的 Agent 至少要能看到"装没装、登没登" —— 面板叫「额度与状态」,
              状态这半边不能只在有额度的那两家身上。 */}
          {agents.length > 0 && (
            <div className="mt-2">
              <p className="mb-1.5 px-1 font-mono text-[9px] tracking-[0.18em] text-wb-faint">
                {t('workbench.quotaOtherAgents', { defaultValue: '其他本机 Agent' })}
              </p>
              <div className="flex flex-col gap-1">
                {agents
                  .filter((agent) => !providers.some((provider) => provider.id === agent.provider))
                  .map((agent) => (
                    <div key={agent.provider} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                      <SessionProviderLogo provider={agent.provider} className="h-3.5 w-3.5 flex-none" />
                      <span className="flex-1 truncate text-[11px] text-foreground">{agent.label}</span>
                      <span className={cn(
                        'font-mono text-[9px]',
                        agent.updateAvailable ? 'text-warning' : agent.installed ? 'text-primary' : 'text-wb-faint',
                      )}>
                        {agent.status}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <p className="mt-2 px-1 text-[9.5px] leading-relaxed text-wb-faint">
            {t('workbench.quotaFootnote', {
              defaultValue: '额度直接读各家 CLI 落在本机的状态,不额外登录。标「本机统计」的是日志累加值,不是官方配额。',
            })}
          </p>
        </div>
      )}
    </div>
  );
}

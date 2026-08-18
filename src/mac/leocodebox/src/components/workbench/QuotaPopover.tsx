import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Gauge, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../utils/apiClient';
import { startVisibleInterval } from '../../utils/visibilityInterval';
import { cn } from '../../lib/utils';
import { formatCny, formatCountCn, formatTokensCn } from '../dashboard/format';
import SessionProviderLogo from '../llm-logo-provider/SessionProviderLogo';

import MetricRow from './MetricRow';
import UsageProgressBar from './UsageProgressBar';
import { useLocalAgents } from './useLocalAgents';
import {
  displayPercent,
  formatMetaText,
  formatPercentLabel,
  formatResetText,
  formatWindowLabel,
  headerSubtitle,
  quotaTone,
  quotaTrust,
  visibleMetrics,
  warningMarkerPercents,
} from './quotaFormat';
import type { ProviderSnapshot, Translate } from './quotaFormat';

type GatewayStatus = {
  enabled: boolean;
  meter: { today: { requests: number; inputTokens: number; outputTokens: number; costUsd: number } };
};

const REFRESH_MS = 120_000;
/** 打开时每 30 秒重算一次"还有多久重置" —— 秒级跳动在菜单里是噪音。 */
const TICK_MS = 30_000;

/** 卡片版式常量,照抄上游 CodexBar(MIT,见 NOTICE)。 */
const CARD_WIDTH = 310;
const CARD_PADDING = 20;
const CONTENT_WIDTH = CARD_WIDTH - CARD_PADDING * 2;

function Divider() {
  return <div className="h-px bg-border" />;
}

/**
 * 三档状态色。上游那条永远是品牌色,严重度只体现在配速条纹上;本项目额外要求
 * "剩余 ≤10% 红、≤50% 橙",所以在这里接管填充色。
 */
function toneColor(usedPercent: number, accentColor: string): string {
  const tone = quotaTone(usedPercent);
  if (tone === 'critical') return 'hsl(var(--destructive))';
  if (tone === 'warning') return 'hsl(var(--warning))';
  return accentColor;
}

/** 上游的 section 节奏:usage 区上边距 10px,其余 6px;下边距统一 6px。 */
function Section({ usage = false, children }: { usage?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('px-5 pb-[6px]', usage ? 'pt-[10px]' : 'pt-[6px]')}>{children}</div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-medium leading-[1.35] text-foreground">{children}</div>;
}

/**
 * 邮箱走中间截断(上游是 .middle truncationMode)。CSS 没有中间省略号,这里
 * 按 `@` 切开:本地名可截、域名钉死 —— 域名恰好是分辨账号时最有用的一半,
 * 尾截断会把它吃掉。
 */
function MiddleTruncatedEmail({ email }: { email: string }) {
  const at = email.lastIndexOf('@');
  const [head, tail] = at > 0 ? [email.slice(0, at), email.slice(at)] : [email, ''];
  return (
    <span
      className="flex min-w-0 max-w-[60%] text-[10.5px] leading-[1.3] text-muted-foreground"
      title={email}
    >
      <span className="truncate">{head}</span>
      {tail && <span className="shrink-0">{tail}</span>}
    </span>
  );
}

export default function QuotaPopover() {
  const { t, i18n } = useTranslation();
  const translate = t as unknown as Translate;
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { agents } = useLocalAgents();

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const [quota, gatewayStatus] = await Promise.all([
        apiClient.get<{ providers?: ProviderSnapshot[] }>(`/api/leocodebox/quota${force ? '?refresh=1' : ''}`),
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
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [open]);

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

  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 900);
  }, []);

  // 状态栏上的迷你计量条取"最紧张的那个权威窗口"—— 一眼看到的应该是最危险的数字,
  // 而本机日志估出来的百分比不配上状态栏。
  const headline = useMemo(() => {
    const windows = providers
      .filter((provider) => quotaTrust(provider.source) === 'authoritative')
      .flatMap((provider) => visibleMetrics(provider, { primary: '', secondary: '', tertiary: '' }));
    if (windows.length === 0) return null;
    return windows.reduce((worst, metric) =>
      (metric.window.usedPercent > worst.window.usedPercent ? metric : worst));
  }, [providers]);

  const today = gateway?.meter?.today;
  const todayTokens = (today?.inputTokens ?? 0) + (today?.outputTokens ?? 0);
  const locale = i18n.language || 'zh-CN';
  const headlineUsed = headline ? Math.round(headline.window.usedPercent) : 0;

  return (
    <div ref={ref} className="relative">
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
                className={cn(
                  'block h-full rounded-full transition-[width] duration-slow',
                  quotaTone(headline.window.usedPercent) === 'critical' ? 'bg-destructive'
                    : quotaTone(headline.window.usedPercent) === 'warning' ? 'bg-warning' : 'bg-primary',
                )}
                style={{ width: `${Math.min(100, headlineUsed)}%` }}
              />
            </span>
            <span className="tabular-nums">{headlineUsed}%</span>
          </>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('workbench.quotaTooltip', { defaultValue: 'AI 额度与状态' })}
          className="wb-anim-card absolute bottom-full right-0 z-[70] mb-2 max-h-[70vh] overflow-y-auto rounded-xl bg-popover py-[6px] font-sans shadow-elevation-3 ring-1 ring-inset ring-border"
          style={{ width: CARD_WIDTH }}
        >
          <div className="flex items-center gap-2 px-5 py-[6px]">
            <span className="flex-1 truncate text-[12.5px] font-semibold text-foreground">
              {t('workbench.quotaTitle', { defaultValue: 'AI 额度' })}
            </span>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
              title={t('workbench.quotaRefresh', { defaultValue: '重新采集' })}
              aria-label={t('workbench.quotaRefresh', { defaultValue: '重新采集' })}
              className="wb-chip-button h-[20px] w-[20px] rounded-md"
            >
              <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
            </button>
          </div>

          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              snapshot={provider}
              now={now}
              locale={locale}
              t={translate}
              copiedKey={copiedKey}
              onCopy={copy}
            />
          ))}

          <Divider />
          <Section>
            <div className="flex items-baseline gap-2">
              <SectionTitle>Leoapi</SectionTitle>
              <span className={cn('h-1.5 w-1.5 rounded-full', gateway?.enabled ? 'bg-primary' : 'bg-wb-faint')} />
              <span className="text-[10.5px] text-muted-foreground">
                {gateway?.enabled
                  ? t('workbench.gatewayRunning', { defaultValue: '网关运行中' })
                  : t('workbench.gatewayOff', { defaultValue: '网关未启用' })}
              </span>
            </div>
            <p className="mt-[3px] text-[10.5px] leading-[1.4] text-muted-foreground">
              {formatTokensCn(todayTokens)} tokens · {formatCountCn(today?.requests ?? 0)} · {formatCny(today?.costUsd ?? 0)}
            </p>
          </Section>

          {/* 读不到额度的 Agent 至少要能看到"装没装、登没登" —— 面板叫「额度与状态」,
              状态这半边不能只在有额度的那两家身上。 */}
          {agents.length > 0 && (
            <>
              <Divider />
              <Section>
                <div className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {t('workbench.quotaOtherAgents', { defaultValue: '其他本机 Agent' })}
                </div>
                <div className="mt-[4px] flex flex-col gap-[3px]">
                  {agents
                    .filter((agent) => !providers.some((provider) => provider.id === agent.provider))
                    .map((agent) => (
                      <div key={agent.provider} className="flex items-baseline gap-2">
                        <SessionProviderLogo provider={agent.provider} className="h-3 w-3 shrink-0 self-center" />
                        <span className="flex-1 truncate text-[10px] text-muted-foreground">{agent.label}</span>
                        <span className={cn(
                          'shrink-0 text-[10px]',
                          agent.updateAvailable ? 'text-warning' : 'text-muted-foreground',
                        )}>
                          {agent.status}
                        </span>
                      </div>
                    ))}
                </div>
              </Section>
            </>
          )}

          <Divider />
          <Section>
            <p className="text-[9.5px] leading-normal text-wb-faint">
              {t('workbench.quotaFootnote', {
                defaultValue: '额度直接读各家 CLI 落在本机的状态,不额外登录。标「本机统计」的是日志累加值,不是官方配额。',
              })}
            </p>
          </Section>
        </div>
      )}
    </div>
  );
}

type ProviderCardProps = {
  snapshot: ProviderSnapshot;
  now: number;
  locale: string;
  t: Translate;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
};

function ProviderCard({ snapshot, now, locale, t, copiedKey, onCopy }: ProviderCardProps) {
  const trust = quotaTrust(snapshot.source);
  const subtitle = headerSubtitle(snapshot, now, t);
  const metrics = visibleMetrics(snapshot, {
    primary: t('workbench.quotaWindowPrimary'),
    secondary: t('workbench.quotaWindowSecondary'),
    tertiary: t('workbench.quotaWindowTertiary'),
  });
  const accent = snapshot.accentColor || 'hsl(var(--primary))';
  const credits = snapshot.credits;
  const cost = snapshot.cost;
  const details = snapshot.details ?? [];
  const errorKey = `error:${snapshot.id}`;

  const creditsUsedPercent = credits && credits.total && credits.total > 0 && credits.remaining != null
    ? Math.max(0, Math.min(100, (1 - credits.remaining / credits.total) * 100))
    : null;

  const emptyText = snapshot.status === 'unconfigured'
    ? (snapshot.note || t('workbench.quotaUnconfiguredHint'))
    : snapshot.status === 'error'
      ? t('workbench.quotaLimitsUnavailable')
      : snapshot.updatedAt == null
        ? t('workbench.quotaNoUsageYet')
        : t('workbench.quotaNoUsageConfigured');

  return (
    <>
      <Divider />

      {/* ① Header:两行。第一行 名字 — 邮箱;第二行 副标题 — [复制] — 套餐。 */}
      <div className="flex flex-col gap-[4px] px-5 py-[6px]">
        <div className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold leading-[1.3] text-foreground">
            {snapshot.label}
          </span>
          {snapshot.identity?.accountEmail && (
            <MiddleTruncatedEmail email={snapshot.identity.accountEmail} />
          )}
        </div>

        <div className="flex items-baseline gap-3">
          <span
            className={cn(
              'min-w-0 flex-1 text-[10.5px] leading-[1.4]',
              subtitle.kind === 'error' ? 'line-clamp-4 text-destructive' : 'truncate text-muted-foreground',
            )}
          >
            {subtitle.text}
          </span>
          {subtitle.kind === 'error' && (
            <button
              type="button"
              onClick={() => onCopy(errorKey, subtitle.text)}
              title={t('workbench.quotaCopyError')}
              aria-label={t('workbench.quotaCopyError')}
              className="shrink-0 self-center text-muted-foreground transition-colors duration-fast hover:text-foreground"
            >
              {copiedKey === errorKey
                ? <Check className="h-3 w-3 text-success" />
                : <Copy className="h-3 w-3" />}
            </button>
          )}
          <span className="shrink-0 text-[10.5px] leading-[1.4] text-muted-foreground">
            {/* 数据可信度必须写在脸上:本机日志估算不能长得像官方额度。 */}
            {trust === 'local' && (
              <span className="text-warning">{t('workbench.quotaLocalTally', { defaultValue: '本机统计' })}</span>
            )}
            {trust === 'authoritative' && <span>{t('workbench.quotaTrustAuthoritative')}</span>}
            {snapshot.identity?.plan && <span className="ml-1.5">{snapshot.identity.plan}</span>}
          </span>
        </div>
      </div>

      {/* ③ Usage 区:metric 之间 12px。unconfigured 不画进度条,只说缺什么。 */}
      <Divider />
      <Section usage>
        {metrics.length > 0 ? (
          <div className="flex flex-col gap-3">
            {metrics.map((metric) => (
              <MetricRow
                key={metric.key}
                title={metric.title}
                percentLabel={formatPercentLabel(metric.window.usedPercent, 'left', t)}
                resetText={formatResetText(metric.window.resetsAt, now, t, {
                  locale,
                  description: metric.window.resetDescription,
                })}
                metaText={formatMetaText(metric.pace, t)}
                detailText={formatWindowLabel(metric.window.windowMinutes, t)}
                usedPercent={metric.window.usedPercent}
                fillColor={toneColor(metric.window.usedPercent, accent)}
                pace={metric.pace}
                windowMinutes={metric.window.windowMinutes}
                barWidth={CONTENT_WIDTH}
              />
            ))}
          </div>
        ) : (
          <p className="text-[10.5px] leading-[1.4] text-muted-foreground">{emptyText}</p>
        )}
      </Section>

      {credits && (credits.remaining != null || credits.total != null) && (
        <>
          <Divider />
          <Section>
            <SectionTitle>{t('workbench.quotaCreditsTitle')}</SectionTitle>
            {creditsUsedPercent != null && (
              <UsageProgressBar
                percent={displayPercent(creditsUsedPercent, 'left')}
                fillColor={toneColor(creditsUsedPercent, accent)}
                markerPercents={warningMarkerPercents(undefined, 'left')}
                width={CONTENT_WIDTH}
                className="my-[6px] block"
              />
            )}
            <div className="flex items-baseline gap-3 text-[10px]">
              {credits.remaining != null && (
                <span className="flex-1 truncate text-foreground">
                  {t('workbench.quotaCreditsLeft', { value: formatCredit(credits.remaining, credits.unit) })}
                </span>
              )}
              {credits.total != null && (
                <span className="shrink-0 text-muted-foreground">
                  {t('workbench.quotaCreditsTotal', { value: formatCredit(credits.total, credits.unit) })}
                </span>
              )}
            </div>
            {credits.hint && (
              <p className="mt-[2px] text-[10px] leading-[1.4] text-muted-foreground">{credits.hint}</p>
            )}
          </Section>
        </>
      )}

      {cost && (cost.todayUSD != null || cost.last30DaysUSD != null) && (
        <>
          <Divider />
          <Section>
            <SectionTitle>{t('workbench.quotaCostTitle')}</SectionTitle>
            <p className="mt-[2px] text-[10.5px] leading-normal text-muted-foreground">
              {t('workbench.quotaCostToday', {
                cost: formatCny(cost.todayUSD ?? 0),
                tokens: formatTokensCn(cost.todayTokens ?? 0),
              })}
            </p>
            <p className="text-[10.5px] leading-normal text-muted-foreground">
              {t('workbench.quotaCostLast30', {
                cost: formatCny(cost.last30DaysUSD ?? 0),
                tokens: formatTokensCn(cost.last30DaysTokens ?? 0),
              })}
            </p>
          </Section>
        </>
      )}

      {details.map((section) => (
        <div key={section.title}>
          <Divider />
          <Section>
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {section.title}
            </div>
            <div className="mt-[4px] flex flex-col gap-[2px]">
              {section.rows.map((row) => (
                <div key={`${row.label}:${row.value}`} className="flex items-baseline gap-3 text-[10px]">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
                  <span className="shrink-0 truncate font-medium text-foreground">
                    {row.value}
                    {row.secondaryValue && (
                      <span className="ml-1.5 font-normal text-muted-foreground">{row.secondaryValue}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        </div>
      ))}
    </>
  );
}

function formatCredit(value: number, unit?: string | null): string {
  const text = Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return unit ? `${text} ${unit}` : text;
}

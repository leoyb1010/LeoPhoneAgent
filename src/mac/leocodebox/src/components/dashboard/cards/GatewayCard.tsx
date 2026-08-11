import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Radio, ArrowRight } from 'lucide-react';

import { apiClient } from '../../../utils/apiClient';
import { startVisibleInterval } from '../../../utils/visibilityInterval';
import { formatCny, formatCountCn, formatTokensCn } from '../format';

import { DashCard, DashCardTitle, DashError, StatusDot } from './dashShared';

type MeterTotals = { requests: number; inputTokens: number; outputTokens: number; costUsd: number; day?: string };
type MeterRecord = { at: number; provider: string; model: string | null; inputTokens: number; outputTokens: number; costUsd: number; ok: boolean };
type MeterRouting = { activeNodes: number; retries: number; window: number };
type CompactionMeter = { requests: number; touchedBlocks: number; savedChars: number };
type GatewayStatus = {
  enabled: boolean;
  compaction?: boolean;
  baseUrl: string | null;
  meter: { today: MeterTotals; routing?: MeterRouting; recent: MeterRecord[] };
  compactionMeter?: CompactionMeter;
};

const REFRESH_MS = 15_000;

/**
 * Leoapi 网关 (phase 1) — opt-in, default-off. Toggling it on routes the active
 * Leoapi provider's Claude traffic through the loopback metering gateway and
 * shows request-level wire usage here. Deliberately calm: one switch, a live
 * pulse, three numbers.
 */
export default function GatewayCard({ delay = 0 }: { delay?: number }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get<GatewayStatus>('/api/leocodebox/gateway/status');
      if (mounted.current) { setStatus(data); setLoadError(null); }
    } catch (error) {
      // Keep the last known status (a transient failure shouldn't blank the
      // card), but if we never got one, say so: rendering the "off" copy with a
      // dead toggle made an unreachable gateway look identical to a disabled
      // one, and clicking did nothing.
      if (mounted.current) setLoadError(error instanceof Error ? error.message : '网关状态读取失败');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const stop = startVisibleInterval(load, REFRESH_MS);
    return () => { mounted.current = false; stop(); };
  }, [load]);

  const toggle = useCallback(async () => {
    if (!status || busy) return;
    setBusy(true);
    const next = !status.enabled;
    setStatus({ ...status, enabled: next }); // optimistic
    try {
      await apiClient.put('/api/leocodebox/gateway/toggle', { enabled: next });
      await load();
    } catch {
      if (mounted.current) setStatus((prev) => (prev ? { ...prev, enabled: !next } : prev));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [status, busy, load]);

  const toggleCompaction = useCallback(async () => {
    if (!status || busy) return;
    setBusy(true);
    const next = !status.compaction;
    setStatus({ ...status, compaction: next }); // optimistic
    try {
      await apiClient.put('/api/leocodebox/gateway/compaction', { enabled: next });
      await load();
    } catch {
      if (mounted.current) setStatus((prev) => (prev ? { ...prev, compaction: !next } : prev));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [status, busy, load]);

  const enabled = status?.enabled ?? false;
  const compaction = status?.compaction ?? false;
  const today = status?.meter.today;
  const routing = status?.meter.routing;
  const savedChars = status?.compactionMeter?.savedChars ?? 0;
  const recent = status?.meter.recent ?? [];
  // Only surface routing when it actually happened: >1 node served, or a
  // failover fired. Otherwise the card stays calm (single node, no noise).
  const showRouting = !!routing && (routing.activeNodes > 1 || routing.retries > 0);

  return (
    <DashCard delay={delay} className={`relative overflow-hidden p-4 transition-shadow ${enabled ? 'shadow-elevation-1' : ''}`}>
      {/* Active accent: a calm top gradient hairline that only lights up when on. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-px transition-opacity duration-slow ${enabled ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: 'linear-gradient(90deg, transparent, hsl(var(--primary)), transparent)' }}
      />

      <DashCardTitle
        title={
          <span className="inline-flex items-center gap-2">
            <Radio className={`h-4 w-4 ${enabled ? 'text-primary' : 'text-muted-foreground'}`} />
            {t('dashboard.gatewayTitle', { defaultValue: 'Leoapi 网关' })}
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">beta</span>
          </span>
        }
        action={
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={busy || !status}
            onClick={() => void toggle()}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        }
      />

      {enabled ? (
        <>
          <div className="mb-3 flex items-center gap-1.5 text-[11px] text-success">
            <StatusDot tone="ok" pulse />
            {t('dashboard.gatewayLive', { defaultValue: '实时计量中 · 仅经网关的请求' })}
            {showRouting && routing && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                  {t('dashboard.gatewayNodes', { defaultValue: '{{n}} 节点分流', n: routing.activeNodes })}
                </span>
                {routing.retries > 0 && (
                  <span className="rounded-md bg-warning/10 px-1.5 py-0.5 font-medium text-warning">
                    {t('dashboard.gatewayFailover', { defaultValue: '{{n}} 次容错', n: routing.retries })}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: t('dashboard.gatewayRequests', { defaultValue: '请求' }), value: formatCountCn(today?.requests ?? 0) },
              { label: 'Tokens', value: formatTokensCn((today?.inputTokens ?? 0) + (today?.outputTokens ?? 0)) },
              { label: t('dashboard.gatewayCost', { defaultValue: '成本' }), value: formatCny(today?.costUsd ?? 0, { decimals: 2 }) },
            ].map((tile) => (
              <div key={tile.label} className="rounded-lg bg-secondary/60 px-2 py-2 text-center">
                <div className="text-[17px] font-medium tabular-nums text-foreground">{tile.value}</div>
                <div className="text-[11px] text-muted-foreground">{tile.label}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 border-t border-border pt-2 text-[11px]">
            <span className={compaction ? 'text-foreground/80' : 'text-muted-foreground'}>
              {t('dashboard.gatewayCompaction', { defaultValue: '上下文瘦身 · 降本' })}
            </span>
            {compaction && savedChars > 0 && (
              <span className="rounded-md bg-success/10 px-1.5 py-0.5 font-medium text-success">
                {t('dashboard.gatewaySaved', { defaultValue: '已省 ~{{n}} 字符', n: formatCountCn(savedChars) })}
              </span>
            )}
            <button
              type="button"
              role="switch"
              aria-checked={compaction}
              aria-label={t('dashboard.gatewayCompaction', { defaultValue: '上下文瘦身 · 降本' })}
              disabled={busy || !status}
              onClick={() => void toggleCompaction()}
              className={`relative ml-auto inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${compaction ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`inline-block h-3 w-3 transform rounded-full bg-background shadow transition-transform ${compaction ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
            </button>
          </div>
          {recent.length > 0 && (
            <div className="mt-3 space-y-1 border-t border-border pt-2">
              {recent.slice(0, 4).map((r) => (
                <div key={r.at} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <StatusDot tone={r.ok ? 'ok' : 'fail'} />
                  <span className="truncate font-mono text-foreground/80">{r.model || r.provider}</span>
                  <span className="ml-auto flex items-center gap-0.5 tabular-nums">
                    {formatTokensCn(r.inputTokens)}<ArrowRight className="h-3 w-3" />{formatTokensCn(r.outputTokens)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : !status && loadError ? (
        // Never loaded: distinguish "unreachable" from "switched off", so the
        // dead toggle has an explanation instead of looking merely disabled.
        <DashError message={loadError} onRetry={() => void load()} />
      ) : (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {t('dashboard.gatewayOff', { defaultValue: '开启后,当前 Leoapi 节点的 Claude 流量将经本机网关转发并按请求实时计量(可随时关闭,默认关)。' })}
        </p>
      )}
    </DashCard>
  );
}

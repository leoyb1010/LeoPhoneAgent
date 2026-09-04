import { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { Check, Copy, ExternalLink, KeyRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../utils/apiClient';
import { startVisibleInterval } from '../../utils/visibilityInterval';
import { cn } from '../../lib/utils';
import { formatCny, formatCountCn, formatTokensCn } from '../dashboard/format';
import SessionProviderLogo from '../llm-logo-provider/SessionProviderLogo';
import { useLeoapiStatus } from '../../hooks/useLeoapiStatus';

type GatewayStatus = {
  enabled: boolean;
  compaction?: boolean;
  baseUrl: string | null;
  meter: {
    today: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
  };
  compactionMeter?: { requests: number; touchedBlocks: number; savedChars: number };
};

type LeoapiPanelProps = {
  onClose: () => void;
  onOpenFullSwitch: () => void;
  onOpenCredentials: () => void;
};

const REFRESH_MS = 15_000;
/** 用量条的满格参考线。纯视觉刻度,不是配额 —— 真正的配额在状态栏的额度浮窗。 */
const DAILY_TOKEN_SCALE = 2_000_000;

/** 分组标题:与会话列表的「进行中 / 今天·已完成」同一套排版。 */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 px-0.5 font-mono text-[9.5px] tracking-[0.18em] text-wb-faint">{children}</h3>
  );
}

/** 卡片:与会话行、设置行同一套(muted 底 + inset 描边 + rounded-lg)。 */
function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg bg-muted px-3.5 py-3 ring-1 ring-inset ring-border', className)}>
      {children}
    </div>
  );
}

/**
 * Leoapi 右滑面板 —— 网关地址、模型路由、今日用量。
 *
 * 排版完全跟着工作台的语言走:等宽小字的分组标题、muted 卡片、芯片按钮、
 * 数字一律 tabular-nums。它回答的是"这台机器的模型流量怎么走的";
 * "还剩多少额度"归状态栏的额度浮窗,两边不重复。
 */
export default function LeoapiPanel({ onClose, onOpenFullSwitch, onOpenCredentials }: LeoapiPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const nodes = useLeoapiStatus();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiClient.get<GatewayStatus>('/api/leocodebox/gateway/status');
        if (!cancelled) setStatus(data);
      } catch {
        // 面板是信息性的,读不到就保留上一次的数字。
      }
    };
    void load();
    const stop = startVisibleInterval(() => void load(), REFRESH_MS);
    return () => { cancelled = true; stop(); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const baseUrl = status?.baseUrl ?? '';
  const copy = useCallback(() => {
    if (!baseUrl) return;
    void navigator.clipboard?.writeText(baseUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [baseUrl]);

  const today = status?.meter?.today;
  const totalTokens = (today?.inputTokens ?? 0) + (today?.outputTokens ?? 0);
  const usageRatio = Math.min(1, totalTokens / DAILY_TOKEN_SCALE);
  const routes = Object.entries(nodes);

  // Portal 到 body:外壳里挂 fixed 浮层会被祖先的定位规则影响,
  // 仓库里的模态一直是这个写法(见 SidebarModals)。
  return ReactDOM.createPortal(
    <>
      <button
        type="button"
        aria-label={t('workbench.closePanel', { defaultValue: '关闭面板' })}
        onClick={onClose}
        className="wb-anim-fade fixed inset-0 z-[56] cursor-default bg-black/35 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Leoapi"
        className="wb-anim-inspector fixed bottom-0 right-0 top-0 z-[57] flex w-[372px] max-w-[92vw] flex-col border-l border-border bg-card tabular-nums shadow-elevation-3"
      >
        {/* 面板头与工作台标题栏同高同重量,视觉上是同一条带子的延续。 */}
        <header className="flex h-[46px] flex-none items-center gap-2.5 border-b border-border px-[22px]">
          <span className="text-[13px] font-bold text-foreground">Leoapi</span>
          <span className="flex items-center gap-1.5 font-mono text-[9.5px] text-wb-faint">
            <span className={cn('h-1.5 w-1.5 rounded-full', status?.enabled ? 'bg-primary' : 'bg-wb-faint')} />
            {status?.enabled
              ? t('workbench.gatewayRunning', { defaultValue: '网关运行中' })
              : t('workbench.gatewayOff', { defaultValue: '网关未启用' })}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('workbench.closePanel', { defaultValue: '关闭面板' })}
            className="wb-chip-button ml-auto h-[26px] w-[26px]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[22px] py-5">
          <section className="wb-anim-entry">
            <GroupLabel>{t('workbench.gatewayLocal', { defaultValue: '本机网关' })}</GroupLabel>
            <Card>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
                  {baseUrl || t('workbench.gatewayNoUrl', { defaultValue: '网关未启用' })}
                </span>
                <button
                  type="button"
                  onClick={copy}
                  disabled={!baseUrl}
                  className="wb-chip-button h-[22px] flex-none px-2.5 text-[10px] font-semibold text-primary disabled:opacity-50"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? t('workbench.copied', { defaultValue: '已复制' }) : t('workbench.copy', { defaultValue: '复制' })}
                </button>
              </div>
              <p className="mt-1.5 text-[10px] text-wb-faint">
                {t('workbench.gatewayHint', { defaultValue: 'OpenAI 兼容 · 任意本地应用可直接调用' })}
              </p>
            </Card>
          </section>

          <section className="wb-anim-entry">
            <GroupLabel>{t('workbench.modelRouting', { defaultValue: '模型路由' })}</GroupLabel>
            {routes.length === 0 ? (
              <Card>
                <p className="text-[10.5px] leading-relaxed text-wb-faint">
                  {t('workbench.routingNative', { defaultValue: '所有 CLI 都走各自的原生配置,没有经过 Leoapi 改写。' })}
                </p>
              </Card>
            ) : (
              <div className="flex flex-col gap-1.5">
                {routes.map(([target, node]) => (
                  <Card key={target} className="flex items-center gap-2.5 py-2.5">
                    <SessionProviderLogo provider={target} className="h-4 w-4 flex-none" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold text-foreground">
                        {target} → {node.name}
                      </span>
                      <span className="mt-px block font-mono text-[9.5px] text-wb-faint">
                        {node.latencyMs === null
                          ? t('workbench.routeActive', { defaultValue: '已生效' })
                          : `${node.latencyMs} ms`}
                      </span>
                    </span>
                    <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary" />
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section className="wb-anim-entry">
            <GroupLabel>{t('workbench.usageToday', { defaultValue: '今日用量' })}</GroupLabel>
            <Card>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[15px] font-semibold text-foreground">
                  {formatTokensCn(totalTokens)}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{formatCny(today?.costUsd ?? 0)}</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-background">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-slow"
                  style={{ width: `${Math.round(usageRatio * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 font-mono text-[9.5px] text-wb-faint">
                tokens · {formatCountCn(today?.requests ?? 0)} 次调用
              </p>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[10.5px]">
                <span className="text-muted-foreground">自动上下文保护</span>
                <span className={status?.compaction ? 'text-success' : 'text-wb-faint'}>
                  {status?.compaction
                    ? `已开启 · 省约 ${formatCountCn(status.compactionMeter?.savedChars ?? 0)} 字符`
                    : '已关闭'}
                </span>
              </div>
            </Card>
          </section>
        </div>

        <footer className="flex flex-none flex-col gap-1.5 border-t border-border px-[22px] py-3">
          <button type="button" onClick={onOpenFullSwitch} className="wb-chip-button h-8 text-[11px] font-semibold">
            <ExternalLink className="h-3 w-3" />
            {t('workbench.openFullSwitch', { defaultValue: '打开完整网关设置' })}
          </button>
          <button type="button" onClick={onOpenCredentials} className="wb-chip-button h-8 text-[11px]">
            <KeyRound className="h-3 w-3" />
            {t('workbench.credentialsHint', { defaultValue: '请求追踪与密钥管理' })}
          </button>
        </footer>
      </aside>
    </>,
    document.body,
  );
}

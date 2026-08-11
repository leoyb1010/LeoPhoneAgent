import { Check, Loader2, Lock, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { Badge } from '../../../shared/view/ui';
import SettingsCard from '../../settings/view/SettingsCard';
import SettingsRow from '../../settings/view/SettingsRow';
import SettingsSection from '../../settings/view/SettingsSection';
import { MCP_PROVIDER_NAMES, MCP_SUPPORTED_TRANSPORTS } from '../constants';
import { mcpChipKey, useMcpOverview } from '../hooks/useMcpOverview';
import type { McpProvider } from '../types';

const PROVIDERS = Object.keys(MCP_PROVIDER_NAMES) as McpProvider[];

/**
 * Cross-CLI roll-up of installed MCP servers. Each row's per-CLI chip is clickable:
 * filled = installed (click removes), dashed = absent (click copies the config in).
 * Writes go through the server's transactional backup. Managed (cloudcli-) rows
 * stay read-only since leocodebox owns them.
 */
export default function McpOverview() {
  const { t } = useTranslation();
  const { rows, loading, errors, pending, writeError, installTo, removeFrom } = useMcpOverview(true);

  return (
    <SettingsSection
      className="mb-6"
      title={t('mcpOverview.title', { defaultValue: 'MCP 全景（跨 CLI）' })}
      description={t('mcpOverview.description', {
        defaultValue: '汇总各 Agent CLI 已装的 MCP 服务器,按名去重。点 CLI 标签即可在该 CLI 上安装/移除(实心=已装,虚线=可装)。',
      })}
    >
      {(errors.length > 0 || writeError) && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning dark:text-warning">
          {writeError || `${t('mcpOverview.partialError', { defaultValue: '部分 CLI 配置未能读取：' })}${errors.join('；')}`}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <SettingsCard divided>
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center justify-between gap-4 px-4 py-4">
              <div className="skeleton h-4 w-40 rounded-md" />
              <div className="skeleton h-5 w-24 rounded-md" />
            </div>
          ))}
        </SettingsCard>
      ) : rows.length === 0 ? (
        <SettingsCard>
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('mcpOverview.empty', { defaultValue: '还没有检测到任何已安装的 MCP 服务器。' })}
          </div>
        </SettingsCard>
      ) : (
        <SettingsCard divided>
          {rows.map((row) => (
            <SettingsRow
              key={row.name}
              label={row.name}
              description={row.transports.length > 0 ? row.transports.join(' · ') : undefined}
            >
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {row.managed ? (
                  <>
                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                      <Lock className="h-3 w-3" />
                      {t('mcpOverview.managed', { defaultValue: '托管' })}
                    </Badge>
                    {row.providers.map((provider) => (
                      <Badge key={provider} variant="secondary">{MCP_PROVIDER_NAMES[provider]}</Badge>
                    ))}
                  </>
                ) : (
                  PROVIDERS.map((provider) => {
                    const installed = row.providers.includes(provider);
                    const busy = pending === mcpChipKey(row.name, provider);
                    // A CLI that doesn't support the row's transport(s) can never
                    // accept the install — don't offer a doomed affordance.
                    const blocked = !installed
                      && row.transports.some((tr) => !MCP_SUPPORTED_TRANSPORTS[provider].includes(tr));
                    return (
                      <button
                        key={provider}
                        type="button"
                        disabled={pending !== null || blocked}
                        onClick={() => {
                          if (blocked) return;
                          void (installed ? removeFrom(row, provider) : installTo(row, provider));
                        }}
                        title={blocked
                          ? t('mcpOverview.transportUnsupported', { cli: MCP_PROVIDER_NAMES[provider], transport: row.transports.join(' · '), defaultValue: `${MCP_PROVIDER_NAMES[provider]} 不支持 ${row.transports.join(' · ')} 传输` })
                          : installed
                            ? t('mcpOverview.removeFrom', { cli: MCP_PROVIDER_NAMES[provider], defaultValue: `从 ${MCP_PROVIDER_NAMES[provider]} 移除` })
                            : t('mcpOverview.installTo', { cli: MCP_PROVIDER_NAMES[provider], defaultValue: `安装到 ${MCP_PROVIDER_NAMES[provider]}` })}
                        className={cn(
                          'group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
                          installed
                            ? 'border-primary/40 bg-primary/10 text-primary hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive'
                            : 'border-dashed border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
                          blocked && 'cursor-not-allowed opacity-40 hover:border-border hover:text-muted-foreground',
                          pending !== null && !blocked && 'opacity-60',
                        )}
                      >
                        {busy
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : installed
                            ? <Check className="h-3 w-3" />
                            : <Plus className="h-3 w-3" />}
                        {MCP_PROVIDER_NAMES[provider]}
                      </button>
                    );
                  })
                )}
              </div>
            </SettingsRow>
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}

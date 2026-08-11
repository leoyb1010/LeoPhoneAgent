import { useMemo, useState } from 'react';
import { ArrowUp, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../../utils/apiClient';
import type { CliToolStatus, ProviderAuthStatus } from '../dashboardTypes';

import { DashCard, DashCardTitle, DashEmpty, DashError, DashSkeleton, StatusDot } from './dashShared';

// Display order + label for the seven agent CLIs. The five with an auth
// endpoint show a login state; gemini/hermes show install/version only.
const AGENT_ORDER: Array<{ id: string; label: string; hasAuth: boolean }> = [
  { id: 'claude', label: 'Claude Code', hasAuth: true },
  { id: 'codex', label: 'Codex', hasAuth: true },
  { id: 'cursor', label: 'Cursor', hasAuth: true },
  { id: 'opencode', label: 'OpenCode', hasAuth: true },
  { id: 'grok', label: 'Grok Build', hasAuth: true },
  { id: 'gemini', label: 'Gemini CLI', hasAuth: false },
  { id: 'hermes', label: 'Hermes Agent', hasAuth: false },
];

type AgentGridCardProps = {
  cliTools: CliToolStatus[] | null;
  providerAuth: Record<string, ProviderAuthStatus> | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  delay?: number;
};

export default function AgentGridCard({ cliTools, providerAuth, loading, error, onRefresh, delay = 0 }: AgentGridCardProps) {
  const { t } = useTranslation();
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const toolById = useMemo(() => {
    const map: Record<string, CliToolStatus> = {};
    for (const tool of cliTools ?? []) map[tool.id] = tool;
    return map;
  }, [cliTools]);

  const loggedInCount = useMemo(
    () => AGENT_ORDER.filter((agent) => agent.hasAuth && providerAuth?.[agent.id]?.authenticated).length,
    [providerAuth],
  );
  const authTotal = AGENT_ORDER.filter((agent) => agent.hasAuth).length;

  const handleInstall = async (id: string) => {
    setInstalling(id);
    setInstallError(null);
    try {
      // A failed install answers HTTP 200 with `success:false`, so a resolved
      // promise is NOT proof it worked — check the flag too. Previously both
      // this and the thrown 409 ("没有经过验证的一键安装方式") were swallowed,
      // so the button just flashed and the tool stayed uninstalled with no
      // explanation.
      const result = await apiClient.post<{ success?: boolean; error?: string }>(`/api/leocodebox/cli/${id}/install`);
      if (result?.success === false) {
        setInstallError(result.error || t('dashboard.installFailed', { defaultValue: '安装失败,请查看设置里的详细输出。' }));
        return;
      }
      onRefresh();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : t('dashboard.installFailed', { defaultValue: '安装失败,请查看设置里的详细输出。' }));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <DashCard delay={delay} className="p-4">
      <DashCardTitle
        title={t('dashboard.agentsTitle', { defaultValue: 'Agent 授权与安装' })}
        action={!loading && (
          <span className="text-[12px] text-muted-foreground">
            {t('dashboard.agentsLoggedIn', { count: loggedInCount, total: authTotal, defaultValue: `${loggedInCount} / ${authTotal} 已登录` })}
          </span>
        )}
      />

      {loading ? (
        <DashSkeleton rows={4} />
      ) : error && !cliTools ? (
        <DashError message={error} onRetry={onRefresh} />
      ) : AGENT_ORDER.every((agent) => !toolById[agent.id] && !providerAuth?.[agent.id]) ? (
        <DashEmpty message={t('dashboard.agentsEmpty', { defaultValue: '未检测到任何 Agent CLI' })} />
      ) : (
        <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-border/80 sm:grid-cols-2">
          {installError && (
            <div className="border-b border-border p-2 sm:col-span-2">
              {/* No retry button: the fix is usually manual (see the message),
                  and a 重试 that only dismissed would be its own small lie. */}
              <DashError message={installError} />
            </div>
          )}
          {AGENT_ORDER.map((agent) => {
            const tool = toolById[agent.id];
            const auth = providerAuth?.[agent.id];
            const installed = tool?.installed ?? auth?.installed ?? false;
            const authenticated = agent.hasAuth ? Boolean(auth?.authenticated) : false;
            const hasUpdate = Boolean(tool?.currentVersion && tool?.latestVersion && tool.currentVersion !== tool.latestVersion);

            const tone = !installed ? 'idle' : agent.hasAuth ? (authenticated ? 'ok' : auth?.error ? 'fail' : 'idle') : 'ok';

            return (
              <div
                key={agent.id}
                className="group flex min-h-[64px] items-center gap-3 border-b border-border/70 px-3 py-2.5 transition-colors hover:bg-accent/35 sm:odd:border-r"
              >
                <StatusDot tone={tone} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-[13px] font-medium ${installed ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {tool?.label || agent.label}
                    </span>
                    {hasUpdate && (
                      <span className="ml-auto inline-flex flex-shrink-0 items-center gap-0.5 text-[11px] text-info" title={t('dashboard.canUpdate', { defaultValue: '可更新' })}>
                        <ArrowUp className="h-3 w-3" />
                        {tool?.latestVersion}
                      </span>
                    )}
                  </div>
                  {installed ? (
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        {agent.hasAuth
                          ? authenticated
                            ? auth?.email || t('dashboard.loggedIn', { defaultValue: '已登录' })
                            : t('dashboard.notLoggedIn', { defaultValue: '未登录' })
                          : t('dashboard.installed', { defaultValue: '已安装' })}
                      </span>
                      {tool?.currentVersion && (
                        <span className="flex-shrink-0 font-mono text-muted-foreground/70">v{tool.currentVersion}</span>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={installing === agent.id || !tool?.installSource}
                      onClick={() => void handleInstall(agent.id)}
                      className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-info transition-colors hover:text-info/80 disabled:opacity-50"
                    >
                      <Download className="h-3 w-3" />
                      {installing === agent.id
                        ? t('dashboard.installing', { defaultValue: '安装中…' })
                        : t('dashboard.install', { defaultValue: '一键安装' })}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashCard>
  );
}

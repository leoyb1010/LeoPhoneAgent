import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button } from '../../../../../../../shared/view/ui';
import SessionProviderLogo from '../../../../../../llm-logo-provider/SessionProviderLogo';
import type { AgentProvider, AuthStatus } from '../../../../../types/types';

type AccountContentProps = {
  agent: AgentProvider;
  authStatus: AuthStatus;
  onLogin: () => void;
};

type AgentVisualConfig = {
  name: string;
  description?: string;
};

const agentConfig: Record<AgentProvider, AgentVisualConfig> = {
  claude: { name: 'Claude' },
  cursor: { name: 'Cursor' },
  codex: { name: 'Codex' },
  opencode: { name: 'OpenCode', description: 'OpenCode CLI assistant' },
  grok: { name: 'Grok', description: 'xAI Grok agent' },
};

// One neutral scheme for every provider. The per-provider solid color cards
// (bright blue Claude / purple Cursor) read as giant banners and clashed with
// the rest of Settings — the provider identity already comes from the logo.
const cardVisual = {
  bgClass: 'bg-muted/30',
  borderClass: 'border-border',
  textClass: 'text-foreground',
  subtextClass: 'text-muted-foreground',
  buttonClass: 'bg-primary hover:bg-primary/90 active:bg-primary/80',
};

function authErrorKey(error: string): string {
  const normalized = error.toLowerCase();
  if (normalized.includes('not installed')) return 'agents.authErrors.notInstalled';
  if (normalized.includes('expired')) return 'agents.authErrors.expired';
  if (normalized.includes('unusable')) return 'agents.authErrors.unusable';
  if (
    normalized.includes('not authenticated')
    || normalized.includes('not logged in')
    || normalized.includes('not configured')
    || normalized.includes('no valid tokens')
  ) {
    return 'agents.authErrors.notAuthenticated';
  }
  return 'agents.authErrors.checkFailed';
}

export default function AccountContent({ agent, authStatus, onLogin }: AccountContentProps) {
  const { t } = useTranslation('settings');
  const config = agentConfig[agent];

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center gap-3">
        <SessionProviderLogo provider={agent} className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{config.name}</h3>
          <p className="text-sm text-muted-foreground">
            {t(`agents.account.${agent}.description`, {
              defaultValue: config.description || `${config.name} CLI assistant`,
            })}
          </p>
        </div>
      </div>

      <div className={`${cardVisual.bgClass} border ${cardVisual.borderClass} rounded-lg p-4`}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className={`font-medium ${cardVisual.textClass}`}>
                {t('agents.connectionStatus')}
              </div>
              <div className={`text-sm ${cardVisual.subtextClass}`}>
                {authStatus.loading ? (
                  t('agents.authStatus.checkingAuth')
                ) : authStatus.installed === false ? (
                  t('agents.authStatus.notInstalled', { agent: config.name })
                ) : authStatus.authenticated ? (
                  t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })
                ) : (
                  t('agents.authStatus.notConnected')
                )}
              </div>
            </div>
            <div>
              {authStatus.loading ? (
                <Badge variant="secondary" className="bg-muted">
                  {t('agents.authStatus.checking')}
                </Badge>
              ) : authStatus.authenticated ? (
                <Badge variant="secondary" className="bg-success/15 text-success dark:bg-success/25 dark:text-success">
                  {t('agents.authStatus.connected')}
                </Badge>
              ) : authStatus.installed === false ? (
                <Badge variant="secondary" className="bg-warning/15 text-warning dark:bg-warning/25 dark:text-warning">
                  {t('agents.authStatus.missing')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-muted text-muted-foreground dark:bg-muted dark:text-muted-foreground">
                  {t('agents.authStatus.disconnected')}
                </Badge>
              )}
            </div>
          </div>

          {authStatus.installed !== false && authStatus.method !== 'api_key' && (
            <div className="border-t border-border/50 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className={`font-medium ${cardVisual.textClass}`}>
                    {authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
                  </div>
                  <div className={`text-sm ${cardVisual.subtextClass}`}>
                    {authStatus.authenticated
                      ? t('agents.login.reAuthDescription')
                      : t('agents.login.description', { agent: config.name })}
                  </div>
                </div>
                <Button
                  onClick={onLogin}
                  className={`${cardVisual.buttonClass} text-primary-foreground`}
                  size="sm"
                >
                  <LogIn className="mr-2 h-4 w-4" />
                  {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                </Button>
              </div>
            </div>
          )}

          {authStatus.error && (
            <div className="border-t border-border/50 pt-4">
              <div className="text-sm text-destructive dark:text-destructive">
                {t('agents.error', { error: t(authErrorKey(authStatus.error)) })}
              </div>
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">{t('agents.authErrors.details')}</summary>
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/70 p-2 font-mono text-[11px]">
                  {authStatus.error}
                </pre>
              </details>
            </div>
          )}

          {authStatus.installed === false && (
            <div className="border-t border-border/50 pt-4 text-sm text-muted-foreground">
              {t('agents.installHint', { agent: config.name })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

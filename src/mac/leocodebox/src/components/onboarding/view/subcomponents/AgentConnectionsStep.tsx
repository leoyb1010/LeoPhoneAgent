import type { LLMProvider } from '../../../../types/app';
import type { ProviderAuthStatusMap } from '../../../provider-auth/types';

import AgentConnectionCard from './AgentConnectionCard';

type AgentConnectionsStepProps = {
  providerStatuses: ProviderAuthStatusMap;
  onOpenProviderLogin: (provider: LLMProvider) => void;
};

const providerCards = [
  {
    provider: 'claude' as const,
    title: 'Claude Code',
    connectedClassName: 'bg-info dark:bg-info/20 border-info dark:border-info',
    iconContainerClassName: 'bg-info dark:bg-info/30',
    loginButtonClassName: 'bg-info hover:bg-info',
  },
  {
    provider: 'cursor' as const,
    title: 'Cursor',
    connectedClassName: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800',
    iconContainerClassName: 'bg-purple-100 dark:bg-purple-900/30',
    loginButtonClassName: 'bg-purple-600 hover:bg-purple-700',
  },
  {
    provider: 'codex' as const,
    title: 'OpenAI Codex',
    connectedClassName: 'bg-muted dark:bg-muted/50 border-border dark:border-border',
    iconContainerClassName: 'bg-muted dark:bg-muted',
    loginButtonClassName: 'bg-muted hover:bg-muted dark:bg-muted dark:hover:bg-muted',
  },
  {
    provider: 'opencode' as const,
    title: 'OpenCode',
    connectedClassName: 'bg-zinc-100 dark:bg-zinc-800/50 border-zinc-300 dark:border-zinc-600',
    iconContainerClassName: 'bg-zinc-100 dark:bg-zinc-800',
    loginButtonClassName: 'bg-zinc-800 hover:bg-zinc-900 dark:bg-zinc-700 dark:hover:bg-zinc-600',
  },
];

export default function AgentConnectionsStep({
  providerStatuses,
  onOpenProviderLogin,
}: AgentConnectionsStepProps) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">Connect Your AI Agents</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Login to one or more AI coding assistants. All are optional.
        </p>
      </div>

      <div className="-mr-1 max-h-[38vh] space-y-2 overflow-y-auto pr-1">
        {providerCards.map((providerCard) => (
          <AgentConnectionCard
            key={providerCard.provider}
            provider={providerCard.provider}
            title={providerCard.title}
            status={providerStatuses[providerCard.provider]}
            connectedClassName={providerCard.connectedClassName}
            iconContainerClassName={providerCard.iconContainerClassName}
            loginButtonClassName={providerCard.loginButtonClassName}
            onLogin={() => onOpenProviderLogin(providerCard.provider)}
          />
        ))}
      </div>

      <p className="text-center text-xs text-muted-foreground">You can configure these later in Settings.</p>
    </div>
  );
}

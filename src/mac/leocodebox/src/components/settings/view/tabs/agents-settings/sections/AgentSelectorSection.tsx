import { scrollBehavior } from '../../../../../../utils/motion';
import { PillBar, Pill } from '../../../../../../shared/view/ui';
import SessionProviderLogo from '../../../../../llm-logo-provider/SessionProviderLogo';
import type { AgentProvider } from '../../../../types/types';
import type { AgentSelectorSectionProps } from '../types';

const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
};

export default function AgentSelectorSection({
  agents,
  selectedAgent,
  onSelectAgent,
  agentContextById,
  localTools = [],
}: AgentSelectorSectionProps) {
  const secondaryTools = localTools.filter((tool) => !agents.includes(tool.id as AgentProvider));
  return (
    <div className="flex-shrink-0 border-b border-border px-3 py-2 md:px-4 md:py-3">
      <PillBar className="scrollbar-hide w-full justify-start overflow-x-auto md:w-auto">
        {agents.map((agent) => {
          const dotColor =
            agent === 'claude' ? 'bg-info' :
            agent === 'cursor' ? 'bg-purple-500' :
            agent === 'opencode' ? 'bg-zinc-500' : 'bg-foreground/60';

          return (
            <Pill
              key={agent}
              isActive={selectedAgent === agent}
              onClick={() => onSelectAgent(agent)}
              className="flex-none justify-center"
            >
              <SessionProviderLogo provider={agent} className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">{AGENT_NAMES[agent]}</span>
              {agentContextById[agent].authStatus.authenticated && (
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotColor}`} />
              )}
            </Pill>
          );
        })}
        {secondaryTools.map((tool) => (
          <Pill
            key={tool.id}
            isActive={false}
            onClick={() => {
              // These CLIs have no account pane — the pill jumps to their card
              // in 本机智能体 above. The card is often already on screen, so a
              // brief highlight ring makes the click visibly land somewhere.
              const card = document.getElementById(`cli-tool-${tool.id}`);
              if (!card) return;
              card.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
              card.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background', 'transition-shadow');
              window.setTimeout(() => {
                card.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background', 'transition-shadow');
              }, 1600);
            }}
            className="flex-none justify-center"
          >
            <SessionProviderLogo provider={tool.id} className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{tool.label}</span>
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tool.runnable ? 'bg-success' : 'bg-muted-foreground/40'}`} />
          </Pill>
        ))}
      </PillBar>
    </div>
  );
}

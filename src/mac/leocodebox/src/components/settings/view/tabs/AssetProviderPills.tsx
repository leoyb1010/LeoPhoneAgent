import { PillBar, Pill } from '../../../../shared/view/ui';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { LLMProvider } from '../../../../types/app';

const PROVIDER_NAMES: Partial<Record<LLMProvider, string>> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
};

type AssetProviderPillsProps = {
  providers: LLMProvider[];
  selected: LLMProvider;
  onSelect: (provider: LLMProvider) => void;
};

/** Lightweight provider selector for the top-level MCP / Skills asset tabs. */
export default function AssetProviderPills({ providers, selected, onSelect }: AssetProviderPillsProps) {
  return (
    <div className="flex-shrink-0 border-b border-border px-3 py-2 md:px-4 md:py-3">
      <PillBar className="scrollbar-hide w-full justify-start overflow-x-auto md:w-auto">
        {providers.map((provider) => (
          <Pill
            key={provider}
            isActive={selected === provider}
            onClick={() => onSelect(provider)}
            className="flex-none justify-center"
          >
            <SessionProviderLogo provider={provider} className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{PROVIDER_NAMES[provider] ?? provider}</span>
          </Pill>
        ))}
      </PillBar>
    </div>
  );
}

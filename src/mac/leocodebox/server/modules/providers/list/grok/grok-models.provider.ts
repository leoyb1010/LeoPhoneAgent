import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';
import {
  runProviderCliCommand,
  type CliCommandRunner,
} from '@/modules/providers/services/cli-version.util.js';

// grok's reasoning models take a `--effort` level. grok-composer is a
// fast non-reasoning variant, so it carries no effort selector.
const GROK_MODELS: ProviderModelsDefinition = {
  DEFAULT: 'grok-4.6',
  OPTIONS: [
    {
      value: 'grok-4.6',
      label: 'grok-4.6',
      description: 'Grok 4.6',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    {
      value: 'grok-4.5',
      label: 'grok-4.5',
      description: 'Grok 4.5',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
        ],
      },
    },
    {
      value: 'grok-composer-2.5-fast',
      label: 'grok-composer-2.5-fast',
      description: 'Grok Composer 2.5 Fast',
    },
  ],
};

// Invalidate provider-model caches created before the 1.80 catalog switched
// from a static 4.5 list to official CLI discovery plus the 4.6 fallback.
// Keep this stable until the catalog contract changes again.
const GROK_MODELS_CACHE_FINGERPRINT = 'grok-cli-catalog-v2';

export function parseGrokModels(output: string): { ids: string[]; defaultId: string | null } {
  const ids: string[] = [];
  let defaultId: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[*-]\s+([a-z0-9][a-z0-9._-]*)(?:\s+\(default\))?\s*$/i);
    if (!match) continue;
    const id = match[1];
    if (!ids.includes(id)) ids.push(id);
    if (/\(default\)\s*$/i.test(line)) defaultId = id;
  }
  return { ids, defaultId };
}

function optionFor(id: string): ProviderModelsDefinition['OPTIONS'][number] {
  const fallback = GROK_MODELS.OPTIONS.find((option) => option.value === id);
  if (fallback) return fallback;
  return { value: id, label: id, description: id };
}

export class GrokProviderModels implements IProviderModels {
  constructor(private readonly runCommand: CliCommandRunner = runProviderCliCommand) {}

  async getCacheFingerprint(): Promise<string> {
    return GROK_MODELS_CACHE_FINGERPRINT;
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const result = await this.runCommand('grok', ['models'], 15_000).catch(() => null);
    const parsed = parseGrokModels(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
    const ids = [...parsed.ids, ...GROK_MODELS.OPTIONS.map((option) => option.value)]
      .filter((id, index, all) => all.indexOf(id) === index);
    return {
      DEFAULT: parsed.defaultId ?? GROK_MODELS.DEFAULT,
      OPTIONS: ids.map(optionFor),
    };
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(GROK_MODELS);
  }

  async changeActiveModel(input: ProviderChangeActiveModelInput): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('grok', input);
  }
}

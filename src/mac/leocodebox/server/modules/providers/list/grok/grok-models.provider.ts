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

// grok's reasoning models take a `--effort` level. grok-composer is a
// fast non-reasoning variant, so it carries no effort selector.
const GROK_MODELS: ProviderModelsDefinition = {
  DEFAULT: 'grok-4.5',
  OPTIONS: [
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

export class GrokProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return GROK_MODELS;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(GROK_MODELS);
  }

  async changeActiveModel(input: ProviderChangeActiveModelInput): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('grok', input);
  }
}

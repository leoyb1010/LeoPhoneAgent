import type { DictationRefinementContext } from '@cindy/voice-input-core';

import { getVoiceInputHistoryForRefinement } from '@/hooks/useVoiceInputHistory';
import {
  buildVoiceInputDictionaryAliasHints,
  formatVoiceInputDictionary,
  type VoiceInputSettings,
} from '../../shared/voiceInputData';
import { buildVoiceInputHistoryContext } from './refinementContext';

type BaseRefinementSettings = Pick<
  VoiceInputSettings,
  'dictionaryEntries' | 'language' | 'refinementInstructions'
>;

type BuildBaseVoiceInputRefinementContextOptions = {
  settings: BaseRefinementSettings;
  uiLanguage?: string;
};

export function resolveBrowserVoiceInputLanguage(language: string): string {
  if (language.trim().toLowerCase() !== 'auto') return language;
  return navigator.language || 'auto';
}

export function buildBaseVoiceInputRefinementContext(
  options: BuildBaseVoiceInputRefinementContextOptions,
): DictationRefinementContext {
  const { settings } = options;
  return {
    uiLanguage: options.uiLanguage ?? navigator.language,
    sourceLanguage: resolveBrowserVoiceInputLanguage(settings.language),
    userRefinementInstructions: settings.refinementInstructions.trim() || undefined,
    userDictionary: formatVoiceInputDictionary(settings.dictionaryEntries) || undefined,
    dictionaryAliasHints: buildVoiceInputDictionaryAliasHints(settings.dictionaryEntries),
    ...buildVoiceInputHistoryContext(getVoiceInputHistoryForRefinement()),
  };
}


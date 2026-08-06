import {
  DEFAULT_UTILITY_MODEL,
  DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN,
  DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
  estimateUtilityModelCostUsd,
  getUtilityModelProfile,
  getUtilityModelProfiles,
  isUtilityModelProviderKind,
  resolveUtilityModelProviderKindAlias,
  type UtilityModelAuthKind,
  type UtilityModelPricing,
  type UtilityModelProviderKind,
  type UtilityModelSettingsTab,
  type UtilityModelTransport,
} from './utilityModelProfiles.js';

export type VoiceInputRefinerTransport = UtilityModelTransport;
export type VoiceInputRefinerAuthKind = UtilityModelAuthKind;
export type VoiceInputRefinerSettingsTab = UtilityModelSettingsTab;
export type VoiceInputRefinerPricing = UtilityModelPricing;

export type VoiceInputRefinerProfile = {
  id: string;
  model: string;
  transport: VoiceInputRefinerTransport;
  auth: VoiceInputRefinerAuthKind;
  settingsTab: VoiceInputRefinerSettingsTab;
  pricing?: VoiceInputRefinerPricing;
  missingCredentialMessage: string;
};

export const DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND = DEFAULT_UTILITY_MODEL_PROVIDER_KIND;
export const DEFAULT_VOICE_INPUT_REFINER_MODEL = DEFAULT_UTILITY_MODEL;
export const DEFAULT_VOICE_INPUT_REFINER_PROVIDER_CHAIN = DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN;

export type VoiceInputRefinerProviderKind = UtilityModelProviderKind;

export function getVoiceInputRefinerProfile(provider: VoiceInputRefinerProviderKind): VoiceInputRefinerProfile {
  const profile = getUtilityModelProfile(provider);
  return {
    ...profile,
    missingCredentialMessage: profile.auth === 'codex'
      ? 'Codex ChatGPT login is required for voice input refinement.'
      : 'API key is required for LiteLLM voice input refinement.',
  };
}

export function getVoiceInputRefinerProfiles(): VoiceInputRefinerProfile[] {
  return getUtilityModelProfiles().map((profile) => getVoiceInputRefinerProfile(profile.id as VoiceInputRefinerProviderKind));
}

export function isVoiceInputRefinerProviderKind(value: string): value is VoiceInputRefinerProviderKind {
  return isUtilityModelProviderKind(value);
}

export function resolveVoiceInputRefinerProviderKindAlias(value: string): VoiceInputRefinerProviderKind | null {
  return resolveUtilityModelProviderKindAlias(value);
}

export function estimateVoiceInputRefinerCostUsd(
  profile: VoiceInputRefinerProfile,
  usage: { promptTokens?: number; cachedTokens?: number; completionTokens?: number },
): number {
  return estimateUtilityModelCostUsd(profile, usage);
}

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  LLMProvider,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveInput,
} from '@/shared/types.js';

export const providerSkillsService = {
  /**
   * Lists normalized skills visible to one provider.
   */
  async listProviderSkills(
    providerName: string,
    options?: ProviderSkillListOptions,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.listSkills(options);
  },

  /**
   * Writes one or more global skills for one provider.
   */
  async addProviderSkills(
    providerName: string,
    input: ProviderSkillCreateInput,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.addSkills(input);
  },

  async removeProviderSkill(
    providerName: string,
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: string; directoryName: string }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.removeSkill(input);
  },

  /**
   * Installs the same skill(s) into every provider that supports managed skills.
   * Mirrors `addMcpServerToAllProviders`: iterates the live registry and captures
   * per-provider failures softly (e.g. a provider without managed-skill support)
   * so one unsupported CLI never blocks distribution to the rest.
   */
  async addSkillsToAllProviders(
    input: ProviderSkillCreateInput,
  ): Promise<Array<{ provider: LLMProvider; created: boolean; skills: number; error?: string }>> {
    const results: Array<{ provider: LLMProvider; created: boolean; skills: number; error?: string }> = [];
    for (const provider of providerRegistry.listProviders()) {
      try {
        const skills = await provider.skills.addSkills(input);
        results.push({ provider: provider.id, created: true, skills: skills.length });
      } catch (error) {
        results.push({
          provider: provider.id,
          created: false,
          skills: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    return results;
  },

  /**
   * Removes one skill from every provider that supports managed skills.
   */
  async removeSkillFromAllProviders(
    input: ProviderSkillRemoveInput,
  ): Promise<Array<{ provider: LLMProvider; removed: boolean; error?: string }>> {
    const results: Array<{ provider: LLMProvider; removed: boolean; error?: string }> = [];
    for (const provider of providerRegistry.listProviders()) {
      try {
        const result = await provider.skills.removeSkill(input);
        results.push({ provider: provider.id, removed: result.removed });
      } catch (error) {
        results.push({
          provider: provider.id,
          removed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    return results;
  },
};

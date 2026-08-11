import { useState } from 'react';

import { useAppPreferences } from '../../../../contexts/PreferencesContext';
import type { LLMProvider } from '../../../../types/app';
import { ProviderSkills } from '../../../skills';
import type { SkillsProject } from '../../../skills/types';
import type { SettingsProject } from '../../types/types';

import AssetProviderPills from './AssetProviderPills';

// OpenCode has no managed-skills UI (mirrors the prior selectedAgent !== 'opencode' guard).
const SKILLS_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex'];

type SkillsSettingsTabProps = { projects: SettingsProject[] };

/** Top-level Skills tab: a per-CLI skill manager with its own provider selector. */
export default function SkillsSettingsTab({ projects }: SkillsSettingsTabProps) {
  const { preferences } = useAppPreferences();
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider>(
    SKILLS_PROVIDERS.includes(preferences.defaultProvider) ? preferences.defaultProvider : 'claude',
  );

  const currentProjects = projects.map<SkillsProject>((project) => ({
    projectId: project.name,
    displayName: project.displayName,
    fullPath: project.fullPath,
    path: project.path,
  }));

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <AssetProviderPills providers={SKILLS_PROVIDERS} selected={selectedProvider} onSelect={setSelectedProvider} />
      <div className="min-w-0 flex-1 space-y-6 overflow-y-auto overflow-x-hidden p-3 md:p-4">
        <ProviderSkills selectedProvider={selectedProvider} currentProjects={currentProjects} />
      </div>
    </div>
  );
}

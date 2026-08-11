import { useState } from 'react';

import { useAppPreferences } from '../../../../contexts/PreferencesContext';
import type { LLMProvider } from '../../../../types/app';
import { McpOverview, McpServers } from '../../../mcp';
import type { McpProject } from '../../../mcp/types';
import type { SettingsProject } from '../../types/types';

import AssetProviderPills from './AssetProviderPills';

const MCP_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

type McpSettingsTabProps = { projects: SettingsProject[] };

/** Top-level MCP tab: cross-CLI overview + a per-CLI server editor. */
export default function McpSettingsTab({ projects }: McpSettingsTabProps) {
  const { preferences } = useAppPreferences();
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider>(
    MCP_PROVIDERS.includes(preferences.defaultProvider) ? preferences.defaultProvider : 'claude',
  );

  const currentProjects = projects.map<McpProject>((project) => ({
    projectId: project.name,
    displayName: project.displayName,
    fullPath: project.fullPath,
    path: project.path,
  }));

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <AssetProviderPills providers={MCP_PROVIDERS} selected={selectedProvider} onSelect={setSelectedProvider} />
      <div className="min-w-0 flex-1 space-y-6 overflow-y-auto overflow-x-hidden p-3 md:p-4">
        <McpOverview />
        <McpServers selectedProvider={selectedProvider} currentProjects={currentProjects} />
      </div>
    </div>
  );
}

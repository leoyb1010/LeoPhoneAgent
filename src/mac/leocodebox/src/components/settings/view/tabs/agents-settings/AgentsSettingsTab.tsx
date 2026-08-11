import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppPreferences } from '../../../../../contexts/PreferencesContext';
import type { AgentCategory, AgentProvider } from '../../../types/types';

import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';
import CliToolsSection from './CliToolsSection';
import type { CliToolStatus } from './CliToolsSection';

export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const { preferences } = useAppPreferences();
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>(preferences.defaultProvider);
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const [localTools, setLocalTools] = useState<CliToolStatus[]>([]);
  const handleToolsChange = useCallback((tools: CliToolStatus[]) => setLocalTools(tools), []);
  // MCP and Skills moved to their own top-level tabs; Agents keeps account/permissions.
  const visibleCategories = useMemo<AgentCategory[]>(() => (
    selectedAgent === 'opencode'
      ? ['account']
      : ['account', 'permissions']
  ), [selectedAgent]);

  const visibleAgents = useMemo<AgentProvider[]>(() => {
    return ['claude', 'cursor', 'codex', 'opencode', 'grok'];
  }, []);

  const agentContextById = useMemo<Record<AgentProvider, AgentContext>>(() => ({
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
    },
    opencode: {
      authStatus: providerAuthStatus.opencode,
      onLogin: () => onProviderLogin('opencode'),
    },
    grok: {
      authStatus: providerAuthStatus.grok,
      onLogin: () => onProviderLogin('grok'),
    },
  }), [
    onProviderLogin,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.opencode,
    providerAuthStatus.grok,
  ]);

  useEffect(() => {
    if (!visibleCategories.includes(selectedCategory)) {
      setSelectedCategory(visibleCategories[0] ?? 'account');
    }
  }, [selectedCategory, visibleCategories]);

  useEffect(() => {
    setSelectedAgent(preferences.defaultProvider);
  }, [preferences.defaultProvider]);

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <CliToolsSection onToolsChange={handleToolsChange} />

      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
        localTools={localTools}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AgentCategoryTabsSection
          categories={visibleCategories}
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />

        <AgentCategoryContentSection
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          agentContextById={agentContextById}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          cursorPermissions={cursorPermissions}
          onCursorPermissionsChange={onCursorPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          projects={projects}
        />
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppPreferences } from '../../../../../contexts/PreferencesContext';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';

type AgentDefaultsSectionProps = {
  preferences: AppPreferences;
  saving: boolean;
  onUpdate: (updates: Partial<AppPreferences>) => Promise<void>;
};

export default function AgentDefaultsSection({ preferences, saving, onUpdate }: AgentDefaultsSectionProps) {
  const { t } = useTranslation('settings');
  const [error, setError] = useState('');
  const save = async (updates: Partial<AppPreferences>) => {
    setError('');
    try { await onUpdate(updates); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t('agentDefaults.saveFailed', { defaultValue: 'Could not save defaults' })); }
  };
  return (
    <div className="border-b border-border p-4 md:p-6">
      <SettingsSection title={t('agentDefaults.title', { defaultValue: 'New task defaults' })}>
        <SettingsCard divided>
          <SettingsRow label={t('appearanceSettings.workspace.defaultAgent')} description={t('appearanceSettings.workspace.defaultAgentDescription')}>
            <select
              aria-label={t('appearanceSettings.workspace.defaultAgent')}
              value={preferences.defaultProvider}
              disabled={saving}
              onChange={(event) => void save({ defaultProvider: event.target.value as typeof preferences.defaultProvider })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-40"
            >
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
              <option value="claude">Claude Code</option>
              <option value="cursor">Cursor</option>
            </select>
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.workspace.defaultModel')} description={t('appearanceSettings.workspace.defaultModelDescription')}>
            <input
              aria-label={t('appearanceSettings.workspace.defaultModel')}
              key={`${preferences.defaultProvider}:${preferences.defaultModel}`}
              defaultValue={preferences.defaultModel}
              disabled={saving}
              placeholder={t('appearanceSettings.workspace.defaultModelPlaceholder')}
              onBlur={(event) => void save({ defaultModel: event.target.value })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-52"
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.workspace.defaultPermission')} description={t('appearanceSettings.workspace.defaultPermissionDescription')}>
            <select
              aria-label={t('appearanceSettings.workspace.defaultPermission')}
              value={preferences.permissionMode}
              disabled={saving}
              onChange={(event) => void save({ permissionMode: event.target.value as typeof preferences.permissionMode })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-40"
            >
              <option value="default">{t('appearanceSettings.workspace.permissionEveryTime')}</option>
              <option value="acceptEdits">{t('appearanceSettings.workspace.permissionAcceptEdits')}</option>
              <option value="bypassPermissions">{t('appearanceSettings.workspace.permissionBypass')}</option>
              <option value="plan">{t('appearanceSettings.workspace.permissionPlan')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

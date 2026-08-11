import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun } from 'lucide-react';

import type { CodeEditorSettingsState, ProjectSortOrder } from '../../types/types';
import LanguageSelector from '../../../../shared/view/ui/LanguageSelector';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { useAppPreferences } from '../../../../contexts/PreferencesContext';
import { useTheme } from '../../../../contexts/ThemeContext';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { preferences, saving, updatePreferences } = useAppPreferences();
  const { themeMode, setThemeMode } = useTheme();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.workspace.agentDefaultsTitle')}>
        <SettingsCard divided>
          <SettingsRow label={t('appearanceSettings.workspace.defaultAgent')} description={t('appearanceSettings.workspace.defaultAgentDescription')}>
            <select
              value={preferences.defaultProvider}
              disabled={saving}
              onChange={(event) => void updatePreferences({ defaultProvider: event.target.value as typeof preferences.defaultProvider })}
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
              key={`${preferences.defaultProvider}:${preferences.defaultModel}`}
              defaultValue={preferences.defaultModel}
              disabled={saving}
              placeholder={t('appearanceSettings.workspace.defaultModelPlaceholder')}
              onBlur={(event) => void updatePreferences({ defaultModel: event.target.value })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-52"
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.workspace.defaultPermission')} description={t('appearanceSettings.workspace.defaultPermissionDescription')}>
            <select
              value={preferences.permissionMode}
              disabled={saving}
              onChange={(event) => void updatePreferences({ permissionMode: event.target.value as typeof preferences.permissionMode })}
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

      <SettingsSection title={t('appearanceSettings.workspace.densityMotionTitle')}>
        <SettingsCard divided>
          <SettingsRow label={t('appearanceSettings.workspace.density')} description={t('appearanceSettings.workspace.densityDescription')}>
            <select
              value={preferences.density}
              disabled={saving}
              onChange={(event) => void updatePreferences({ density: event.target.value as typeof preferences.density })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="compact">{t('appearanceSettings.workspace.compact')}</option>
              <option value="comfortable">{t('appearanceSettings.workspace.comfortable')}</option>
            </select>
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.workspace.reduceMotion')} description={t('appearanceSettings.workspace.reduceMotionDescription')}>
            <SettingsToggle
              checked={preferences.reduceMotion}
              onChange={(value) => void updatePreferences({ reduceMotion: value })}
              ariaLabel={t('appearanceSettings.workspace.reduceMotion')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.workspace.themeTitle')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.workspace.theme')}
            description={t('appearanceSettings.workspace.themeDescription')}
          >
            <div className="inline-flex rounded-lg border border-border bg-muted/60 p-1" role="group" aria-label={t('appearanceSettings.workspace.theme')}>
              {([
                ['system', t('appearanceSettings.workspace.system'), Monitor],
                ['light', t('appearanceSettings.workspace.light'), Sun],
                ['dark', t('appearanceSettings.workspace.dark'), Moon],
              ] as const).map(([mode, label, Icon]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setThemeMode(mode)}
                  aria-pressed={themeMode === mode}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                    themeMode === mode ? 'bg-card text-foreground shadow-elevation-1' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
            >
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

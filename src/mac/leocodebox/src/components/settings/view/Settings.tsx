import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ProviderLoginModal from '../../provider-auth/view/ProviderLoginModal';
import { Button } from '../../../shared/view/ui';
import SettingsSidebar from '../view/SettingsSidebar';
import AgentsSettingsTab from '../view/tabs/agents-settings/AgentsSettingsTab';
import AgentHubTab from '../view/tabs/AgentHubTab';
import McpSettingsTab from '../view/tabs/McpSettingsTab';
import SkillsSettingsTab from '../view/tabs/SkillsSettingsTab';
import AppearanceSettingsTab from '../view/tabs/AppearanceSettingsTab';
import CredentialsSettingsTab from '../view/tabs/api-settings/CredentialsSettingsTab';
import VoiceSettingsTab from '../view/tabs/VoiceSettingsTab';
import GitSettingsTab from '../view/tabs/git-settings/GitSettingsTab';
import BrowserUseSettingsTab from '../view/tabs/browser-use-settings/BrowserUseSettingsTab';
import NotificationsSettingsTab from '../view/tabs/NotificationsSettingsTab';
import TasksSettingsTab from '../view/tabs/tasks-settings/TasksSettingsTab';
import PluginSettingsTab from '../../plugins/view/PluginSettingsTab';
import AboutTab from '../view/tabs/AboutTab';
import { useSettingsController } from '../hooks/useSettingsController';
import { useWebPush } from '../../../hooks/useWebPush';
import type { SettingsProps } from '../types/types';

type DesktopNotificationsState = {
  enabled: boolean;
  supported: boolean;
  connectedCount?: number;
  targetCount?: number;
  lastError?: string | null;
};

function Settings({ isOpen, onClose, projects = [], initialTab = 'agents' }: SettingsProps) {
  const { t } = useTranslation('settings');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const loginModalOpenRef = useRef(false);
  const desktopNotificationsBridge = useMemo(() => (
    typeof window === 'undefined'
      ? null
      : ((window as any).leocodeboxDesktopNotifications || null)
  ), []);
  const [desktopNotificationsState, setDesktopNotificationsState] = useState<DesktopNotificationsState | null>(null);
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    cursorPermissions,
    setCursorPermissions,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  } = useSettingsController({
    isOpen,
    initialTab
  });

  loginModalOpenRef.current = showLoginModal;

  useEffect(() => {
    if (!isOpen) return undefined;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (loginModalOpenRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden') && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [isOpen, onClose]);

  const {
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isLoading: isPushLoading,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
  } = useWebPush();

  const handleEnablePush = async () => {
    await pushSubscribe();
    // Server sets webPush: true in preferences on subscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: true },
    });
  };

  const handleDisablePush = async () => {
    await pushUnsubscribe();
    // Server sets webPush: false in preferences on unsubscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: false },
    });
  };

  useEffect(() => {
    if (!desktopNotificationsBridge) return undefined;
    let mounted = true;
    desktopNotificationsBridge.getState().then((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    }).catch(() => {});
    const unsubscribe = desktopNotificationsBridge.onStateUpdated?.((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [desktopNotificationsBridge]);

  const handleEnableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: true });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: true },
    });
  };

  const handleDisableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: false });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: false },
    });
  };

  if (!isOpen) {
    return null;
  }

  const isAuthenticated = Boolean(loginProvider && providerAuthStatus[loginProvider].authenticated);

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-black/35 backdrop-blur-[3px] md:p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="leocodebox-settings-title" tabIndex={-1} className="leocodebox-settings-dialog flex h-full w-full flex-col overflow-hidden border border-border bg-background shadow-elevation-3 md:h-[88vh] md:max-w-5xl md:rounded-lg">
        {/* Header */}
        <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-border px-4 md:px-5">
          <h2 id="leocodebox-settings-title" className="text-base font-semibold text-foreground">{t('title')}</h2>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span className="text-xs text-muted-foreground animate-in fade-in">{t('saveStatus.success')}</span>
            )}
            {saveStatus === 'error' && (
              <span role="alert" className="text-xs text-destructive animate-in fade-in">{t('saveStatus.error')}</span>
            )}
            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label={t('actions.close', { defaultValue: 'Close' })}
              className="h-10 w-10 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <SettingsSidebar activeTab={activeTab} onChange={setActiveTab} />

          {/* Content */}
          <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div key={activeTab} className="settings-content-enter min-w-0 space-y-6 overflow-x-hidden p-4 pb-safe-area-inset-bottom md:space-y-8 md:p-6">
              {activeTab === 'appearance' && (
                <AppearanceSettingsTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  codeEditorSettings={codeEditorSettings}
                  onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                  onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                  onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                  onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
                />
              )}

              {activeTab === 'git' && <GitSettingsTab />}

              {activeTab === 'agents' && (
                <AgentsSettingsTab
                  providerAuthStatus={providerAuthStatus}
                  onProviderLogin={openLoginForProvider}
                  claudePermissions={claudePermissions}
                  onClaudePermissionsChange={setClaudePermissions}
                  cursorPermissions={cursorPermissions}
                  onCursorPermissionsChange={setCursorPermissions}
                  codexPermissionMode={codexPermissionMode}
                  onCodexPermissionModeChange={setCodexPermissionMode}
                  projects={projects}
                />
              )}

              {activeTab === 'agentHub' && <AgentHubTab onClose={onClose} />}

              {activeTab === 'mcp' && <McpSettingsTab projects={projects} />}

              {activeTab === 'skills' && <SkillsSettingsTab projects={projects} />}

              {activeTab === 'tasks' && <TasksSettingsTab />}

              {activeTab === 'browser' && <BrowserUseSettingsTab />}

              {activeTab === 'notifications' && (
                <NotificationsSettingsTab
                  notificationPreferences={notificationPreferences}
                  onNotificationPreferencesChange={setNotificationPreferences}
                  pushPermission={pushPermission}
                  isPushSubscribed={isPushSubscribed}
                  isPushLoading={isPushLoading}
                  onEnablePush={handleEnablePush}
                  onDisablePush={handleDisablePush}
                  isDesktop={Boolean(desktopNotificationsBridge)}
                  desktopNotifications={desktopNotificationsState}
                  onEnableDesktopNotifications={handleEnableDesktopNotifications}
                  onDisableDesktopNotifications={handleDisableDesktopNotifications}
                />
              )}

              {activeTab === 'api' && <CredentialsSettingsTab />}

              {activeTab === 'voice' && <VoiceSettingsTab />}

              {activeTab === 'plugins' && <PluginSettingsTab />}

              {activeTab === 'about' && <AboutTab />}
            </div>
          </main>
        </div>
      </div>

      <ProviderLoginModal
        key={loginProvider || 'claude'}
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        provider={loginProvider || 'claude'}
        onComplete={handleLoginComplete}
        isAuthenticated={isAuthenticated}
      />

    </div>
  );
}

export default Settings;

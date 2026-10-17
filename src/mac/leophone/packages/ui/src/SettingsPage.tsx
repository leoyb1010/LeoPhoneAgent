/* oxlint-disable eslint(max-lines) */
import { ArrowLeft, type LucideIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  AppSettings,
  DesktopCloseToTrayCapability,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  Locale,
  UserInfo,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_EXTENSIONS_TAB,
  TID_SETTINGS_NAV_SEARCH_INPUT,
  TID_SETTINGS_NAV_SEARCH_RESULT,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_USAGE_TAB,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  addPendingSettingsSectionListener,
  clearPendingSettingsPluginOrigin,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsPluginOrigin,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsPluginTab,
  consumePendingSettingsModelProviderTarget,
  resolveSettingsSection,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { UsageStatsSection } from "@/settings/UsageStatsSection.js";
import { SubagentsSection } from "@/settings/SubagentsSection.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { SegmentPill } from "@/settings/PluginStoreListView.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { HooksSection } from "@/settings/HooksSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { MemorySettingsSection } from "@/settings/MemorySettingsSection.js";
import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";
import { LeoComputerUseSection } from "@/leo/LeoComputerUseSection.js";
import { LeoExternalAgentsSection } from "@/leo/LeoExternalAgentsSection.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import { MigrationSection } from "@/settings/MigrationSection.js";
import { LeoPhoneLinkSection } from "@/leo/LeoPhoneLinkSection.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { resolveSettingsNavEntryId } from "@/settings/settingsPageConfig.js";
import {
  buildSettingsSearchCandidates,
  filterSettingsSearchCandidates,
  type SettingsSearchCandidate,
} from "@/settings/settingsSearch.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { Theme } from "@/useTheme.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";

import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";
import {
  createSettingsPageConfig,
  GeneralSectionContent,
  resolveSettingsSectionForPlatform,
} from "./settingsPageHelpers.js";
import { AppearanceSectionContent } from "./settingsCodePreview.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import {
  runUserAction,
  runUserActionAsync,
  type UserActionResult,
  type UserActionTrigger,
} from "@/lib/userActionTelemetry.js";
import type { SettingsUserActionFeatureId } from "@/lib/userActionTraceCatalog.js";

function runSettingsActionAsync<T>(options: {
  featureId: SettingsUserActionFeatureId;
  action: string;
  trigger: UserActionTrigger;
  operation: () => Promise<T>;
  completed: UserActionResult;
  failureStage?: string;
}): Promise<T> {
  return runUserActionAsync({
    input: {
      featureId: options.featureId,
      action: options.action,
      trigger: options.trigger,
    },
    operation: options.operation,
    completed: options.completed,
    failureStage: options.failureStage ?? "settings_commit",
  });
}

function SettingsUsageProviderTabs() {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex items-center gap-1.5">
      <SegmentPill
        active
        label={intl.formatMessage({ id: "settings.usage.tab.appUsage" })}
        testId={testId(TID_SETTINGS_USAGE_TAB, "app")}
        onClick={() => undefined}
      />
    </div>
  );
}

function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          // [leo] 紧凑导航：行高 h-7、小图标，与 iOS 设置列表的密度对齐。
          "flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors",
          "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0",
          active
            ? "bg-surface-hover text-foreground"
            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className="size-3.5 text-foreground-subtle max-lg:size-4" />
        </span>
        <span className="min-w-0 flex-1 max-lg:sr-only">
          {children ?? <span className="truncate text-ui-base text-foreground">{label}</span>}
        </span>
      </button>
    </ControlHintTooltip>
  );
}

export function SettingsPage({
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  windowsWindowControlsRightPaddingPx: _windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  allowOpenWorkspace = true,
  onLogin,
  onLogout,
  user,
}: {
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  allowOpenWorkspace?: boolean;
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}) {
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const settingsPageConfig = useMemo(
    () =>
      createSettingsPageConfig({
        isDesktop: Boolean(isDesktop),
        isMacDesktop: Boolean(isMacDesktop),
        isWindowsDesktop: Boolean(isWindowsDesktop),
      }),
    [isDesktop, isMacDesktop, isWindowsDesktop],
  );
  const { settingsSectionGroups, settingsSections, extensionSections, extensionsNavEntry } =
    settingsPageConfig;
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const platform = usePlatform();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() =>
    // [leo] 没有显式意图时落在「AI 服务商」，见 docs/specs/leo-settings-ia.md。
    resolveSettingsSectionForPlatform(consumeInitialSettingsSection(), settingsSections),
  );
  const [pluginTab, setPluginTab] = useState(() => consumePendingSettingsPluginTab());
  // Linux 关闭驻留托盘能力查询（spec：docs/desktop/linux-close-to-tray.md）：打开设置页时
  // 经 platform IPC 触发 main 侧探测（带 stale 缓存），用户装完 AppIndicator 扩展重开
  // 设置页即可解除置灰；Web/远控无桥不查询。
  const [linuxCloseToTrayCapability, setLinuxCloseToTrayCapability] =
    useState<DesktopCloseToTrayCapability | null>(null);
  useEffect(() => {
    if (!isLinuxDesktop) {
      return;
    }
    let cancelled = false;
    platform
      .getCloseToTrayCapability?.()
      .then((capability) => {
        if (!cancelled) {
          setLinuxCloseToTrayCapability(capability);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLinuxDesktop, platform]);
  const linuxCloseToTray = isLinuxDesktop
    ? {
        // 探测中按不可用锁定，防止查询完成前误开导致关窗失联
        disabled: linuxCloseToTrayCapability === null || !linuxCloseToTrayCapability.supported,
        unavailable: linuxCloseToTrayCapability?.supported === false,
        gnomeLikeHint:
          linuxCloseToTrayCapability?.supported === false &&
          linuxCloseToTrayCapability.gnomeLikeWithoutTray,
      }
    : undefined;
  const [pluginNavigationOrigin, setPluginNavigationOrigin] = useState(() =>
    consumePendingSettingsPluginOrigin(),
  );
  const [pluginScopeKey, setPluginScopeKey] = useState(() =>
    consumePendingSettingsPluginScopeKey(),
  );
  const [settingsSectionNavigationVersion, setSettingsSectionNavigationVersion] = useState(0);
  useEffect(() => {
    // React Strict Mode 会双执行 state initializer；来源和 scopeKey 都在挂载完成后再清理，
    // Marketplace 只返回 User 已安装视图；Workspace 仍通过设置页自身的配置层切换进入。
    clearPendingSettingsPluginOrigin();
    clearPendingSettingsPluginScopeKey();
  }, []);
  const [settingsBreadcrumbItems, setSettingsBreadcrumbItems] = useState<
    readonly SettingsBreadcrumbItem[]
  >([]);
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const setCodePreviewSettings = useZCodeStore((state) => state.setCodePreviewSettings);
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  const notificationEnabled = useZCodeStore((state) => state.notificationEnabled);
  const setNotificationEnabled = useZCodeStore((state) => state.setNotificationEnabled);
  const notificationSoundEnabled = useZCodeStore((state) => state.notificationSoundEnabled);
  const setNotificationSoundEnabled = useZCodeStore((state) => state.setNotificationSoundEnabled);
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [pendingModelProviderTarget, setPendingModelProviderTarget] = useState<
    SettingsModelProviderTarget | undefined
  >(() => initialModelProviderTarget);
  const requestOnboardingDialog = useZCodeStore((state) => state.requestOnboardingDialog);
  const setActiveSettingsSection = useCallback(
    (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
      setActiveSection(resolveSettingsSection(section, fallbackSection));
    },
    [activeSection],
  );
  const handleOpenModelProviderSettings = useCallback(() => {
    setActiveSettingsSection("modelProvider");
  }, [setActiveSettingsSection]);
  const handleOpenUsageSettings = useCallback(() => {
    // 设置页 sidebar footer 里的齿轮/返回按钮复用 onBack，
    // 但头像菜单的“使用统计”应该停留在设置页并切到 Usage，不能跟着返回工作区。
    setActiveSettingsSection("usage");
  }, [setActiveSettingsSection]);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  // Settings 打开后 activeTab 会变成 settings，本地反查 activeTab 读 identity 会稳定丢失。
  // 这里改为读取 tabStore 维护的“最近激活 workspace identity”，让插件管理继续命中正确远端。
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const activeWorkspaceTab = useTabStore((state) => {
    const workspacePath = state.activeWorkspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentity = state.activeWorkspaceIdentity ?? undefined;
    const matchingTabs = state.tabs
      .filter(isWorkspaceTab)
      .filter((tab) => tab.workspacePath === workspacePath);
    return (
      matchingTabs.find((tab) =>
        workspaceIdentity ? tab.workspaceIdentity === workspaceIdentity : !tab.workspaceIdentity,
      ) ??
      matchingTabs[0] ??
      null
    );
  });
  const localModelProviderConnectivityWorkspacePath = useMemo(
    () =>
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeWorkspaceTab,
        workspaceTabs,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath, activeWorkspaceTab, workspaceTabs],
  );
  const isRemoteModelProviderWorkspace = Boolean(
    activeWorkspaceIdentity?.trim() ||
    activeWorkspaceTab?.remoteSessionId?.trim() ||
    activeWorkspaceTab?.remoteTarget,
  );
  const selectDirectory = useSelectDirectory();
  const services = useServices();
  const localHostServices = useBaseWorkspaceServices();
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings();
  const memoryWorkspaceDisplayNames = useMemo(() => {
    const names = new Set<string>();
    // Memory Scope 的项目顺序以 settings.json recentProjects 为准；打开中的
    // Workspace 只补充尚未持久化的项目，不能抢占最近项目排序。
    for (const path of sharedSettings?.recentProjects ?? []) {
      const name = getPathLeaf(path).trim();
      if (name) names.add(name);
    }
    for (const tab of workspaceTabs) {
      const name = tab.label.trim() || getPathLeaf(tab.workspacePath).trim();
      if (name) names.add(name);
    }
    return [...names];
  }, [sharedSettings?.recentProjects, workspaceTabs]);
  const memoryEnabled = sharedSettings?.memoryEnabled === true;
  const nativeSearchEnhancementsEnabled = sharedSettings?.nativeSearchEnhancementsEnabled !== false;
  const askUserQuestionAutoResolutionEnabled =
    sharedSettings?.askUserQuestionAutoResolutionEnabled !== false;
  const modelIoFullRetentionEnabled = sharedSettings?.modelIoFullRetentionEnabled === true;
  const [dataBaseDir, setDataBaseDir] = useState("");
  const [terminalInheritSystemProfile, setTerminalInheritSystemProfile] = useState(true);
  const [terminalFontFamily, setTerminalFontFamily] = useState("");
  const [integratedTerminalShell, setIntegratedTerminalShell] =
    useState<IntegratedTerminalShellSelection>({ mode: "auto" });
  const [integratedTerminalShellOptions, setIntegratedTerminalShellOptions] = useState<
    IntegratedTerminalShellOption[]
  >([]);
  const [httpProxy, setHttpProxy] = useState("");
  const [httpProxyNoProxy, setHttpProxyNoProxy] = useState("");
  const [httpProxyCaCertPath, setHttpProxyCaCertPath] = useState("");
  const [embeddedBrowserAllowInsecureCertificates, setEmbeddedBrowserAllowInsecureCertificates] =
    useState(false);
  const [taskAutoArchiveEnabled, setTaskAutoArchiveEnabled] = useState(false);
  const [taskAutoArchiveOlderThanDays, setTaskAutoArchiveOlderThanDays] = useState(7);
  const [closeToTrayOnWindows, setCloseToTrayOnWindows] = useState(Boolean(isWindowsDesktop));
  const [
    desktopChromiumHardwareAccelerationEnabled,
    setDesktopChromiumHardwareAccelerationEnabled,
  ] = useState(true);
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [messageStreamShowReasoning, setMessageStreamShowReasoning] = useState(true);
  const [messageStreamShowTodos, setMessageStreamShowTodos] = useState(false);
  const [toolGroupingExploreEnabled, setToolGroupingExploreEnabled] = useState(true);
  const [toolGroupingTerminalEnabled, setToolGroupingTerminalEnabled] = useState(true);
  const [toolGroupingChangesEnabled, setToolGroupingChangesEnabled] = useState(false);
  const [zcodeInteractionBehavior, setZCodeInteractionBehavior] =
    useState<ZCodeInteractionBehavior>("queue");
  const [defaultHomeDir, setDefaultHomeDir] = useState("");
  const [hostPlatform, setHostPlatform] = useState("");

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // SettingsPage 已打开时再次从 quickpick 点“个性化/MCP”等设置入口，
        // 页面不会重新挂载，之前写入的 pending section 无人消费，看起来像点击没反应。
        // 这里订阅同窗口跳转意图，立即切换当前设置分区。
        setActiveSettingsSection(section, activeSection);
        // 设置入口是一级路由边界。即使仍落在同一 section，也必须销毁旧的 New/Edit/Detail 子状态。
        setSettingsSectionNavigationVersion((version) => version + 1);
        if (resolveSettingsSection(section) === "plugin" && detail?.pluginTab) {
          setPluginTab(detail.pluginTab);
          setPluginNavigationOrigin(detail.pluginOrigin);
          setPluginScopeKey(detail.pluginScopeKey);
        } else if (resolveSettingsSection(section) !== "plugin") {
          setPluginNavigationOrigin(undefined);
        }
        if (section === "modelProvider" && detail?.modelProviderId) {
          setPendingModelProviderTarget({
            providerId: detail.modelProviderId,
          });
        }
      }),
    [activeSection, setActiveSettingsSection],
  );

  useEffect(() => {
    services.settingService
      .get()
      .then((settings: AppSettings) => {
        setDataBaseDir(settings.dataBaseDir ?? "");
        setTerminalInheritSystemProfile(settings.terminalInheritSystemProfile ?? true);
        setTerminalFontFamily(settings.terminalFontFamily ?? "");
        setIntegratedTerminalShell(settings.integratedTerminalShell ?? { mode: "auto" });
        setHttpProxy(settings.httpProxy ?? "");
        setHttpProxyNoProxy(settings.httpProxyNoProxy ?? "");
        setHttpProxyCaCertPath(settings.httpProxyCaCertPath ?? "");
        setEmbeddedBrowserAllowInsecureCertificates(
          settings.embeddedBrowserAllowInsecureCertificates ?? false,
        );
        setTaskAutoArchiveEnabled(settings.taskAutoArchiveEnabled ?? false);
        setTaskAutoArchiveOlderThanDays(settings.taskAutoArchiveOlderThanDays ?? 7);
        setCloseToTrayOnWindows(settings.closeToTrayOnWindows ?? Boolean(isWindowsDesktop));
        setDesktopChromiumHardwareAccelerationEnabled(
          settings.desktopChromiumHardwareAccelerationEnabled ?? true,
        );
        setAutoDownloadAndInstallUpdates(settings.autoDownloadAndInstallUpdates ?? false);
        setMessageStreamShowReasoning(settings.messageStreamShowReasoning ?? true);
        setMessageStreamShowTodos(settings.messageStreamShowTodos ?? false);
        setToolGroupingExploreEnabled(settings.toolGroupingExploreEnabled ?? true);
        setToolGroupingTerminalEnabled(settings.toolGroupingTerminalEnabled ?? true);
        setToolGroupingChangesEnabled(settings.toolGroupingChangesEnabled ?? false);
        setZCodeInteractionBehavior(settings.zcodeInteractionBehavior ?? "queue");
      })
      .catch(() => {});
    // 这里配置的是本地全局设置。远端 workspace 激活时 useServices()
    // 可能已经被替换为远端 host，不能用远端 shell 枚举结果写入本机设置。
    localHostServices.systemService
      .info()
      .then((info) => {
        setDefaultHomeDir(info.homedir);
        setHostPlatform(info.platform);
        if (info.platform !== "win32") {
          setIntegratedTerminalShellOptions([]);
          return;
        }
        void localHostServices.systemService
          .listIntegratedTerminalShells()
          .then(setIntegratedTerminalShellOptions)
          .catch(() => {
            setIntegratedTerminalShellOptions([]);
          });
      })
      .catch(() => {});
  }, [localHostServices.systemService, services.settingService, isWindowsDesktop]);

  useEffect(() => {
    if (!sharedSettings) {
      return;
    }
    setMessageStreamShowReasoning(sharedSettings.messageStreamShowReasoning ?? true);
    setMessageStreamShowTodos(sharedSettings.messageStreamShowTodos ?? false);
    setToolGroupingExploreEnabled(sharedSettings.toolGroupingExploreEnabled ?? true);
    setToolGroupingTerminalEnabled(sharedSettings.toolGroupingTerminalEnabled ?? true);
    setToolGroupingChangesEnabled(sharedSettings.toolGroupingChangesEnabled ?? false);
    setZCodeInteractionBehavior(sharedSettings.zcodeInteractionBehavior ?? "queue");
    setAutoDownloadAndInstallUpdates(sharedSettings.autoDownloadAndInstallUpdates ?? false);
  }, [sharedSettings]);
  const handleTerminalInheritSystemProfileChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "toggle_system_profile",
        trigger: "switch",
        operation: () =>
          services.settingService.update({
            terminalInheritSystemProfile: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTerminalInheritSystemProfile(enabled);
    },
    [services.settingService],
  );
  const handleTerminalFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      const normalizedFontFamily = fontFamily.trim();
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "save_font_family",
        trigger: "button",
        operation: () =>
          services.settingService.update({
            terminalFontFamily: normalizedFontFamily,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedFontFamily.length > 0,
        },
      });
      setTerminalFontFamily(normalizedFontFamily);
    },
    [services.settingService],
  );
  const handleIntegratedTerminalShellChange = useCallback(
    async (selection: IntegratedTerminalShellSelection) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "change_shell",
        trigger: "select",
        operation: () =>
          services.settingService.update({
            integratedTerminalShell: selection,
          }),
        completed: {
          resultSource: "setting_service",
          valueAfter: selection.mode === "auto" ? "auto" : "explicit",
        },
      });
      setIntegratedTerminalShell(selection);
    },
    [services.settingService],
  );
  const handleNativeSearchEnhancementsEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "toggle_native_search",
        trigger: "switch",
        operation: () => updateSharedSettings({ nativeSearchEnhancementsEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleAskUserQuestionAutoResolutionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_ask_user_auto_resolution",
        trigger: "switch",
        operation: () =>
          updateSharedSettings({
            askUserQuestionAutoResolutionEnabled: enabled,
          }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleModelIoFullRetentionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_model_io_retention",
        trigger: "switch",
        operation: () => updateSharedSettings({ modelIoFullRetentionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleMemoryEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.memory",
        action: "toggle_memory",
        trigger: "switch",
        operation: async () => {
          await updateSharedSettings({ memoryEnabled: enabled });
        },
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleHttpProxyChange = useCallback(
    async (proxy: string) => {
      const normalizedProxy = proxy.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_http_proxy",
        trigger: "button",
        operation: () =>
          services.settingService.update({
            // Bugfix: RPC 会丢弃 undefined；清空代理必须传空串，由服务层删除旧字段。
            httpProxy: normalizedProxy,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedProxy.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxy(normalizedProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [services.settingService, intl],
  );
  const handleHttpProxyNoProxyChange = useCallback(
    async (noProxy: string) => {
      const normalizedNoProxy = noProxy
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .join(",");
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_no_proxy",
        trigger: "button",
        operation: () =>
          services.settingService.update({
            // Bugfix: 清空 No Proxy 必须传空串，否则旧绕过规则会继续影响下次启动。
            httpProxyNoProxy: normalizedNoProxy,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedNoProxy.length > 0,
        },
      });
      setHttpProxyNoProxy(normalizedNoProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [services.settingService, intl],
  );
  const handleHttpProxyCaCertPathChange = useCallback(
    async (caCertPath: string) => {
      const normalizedCaCertPath = caCertPath.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_ca_certificate",
        trigger: "button",
        operation: () =>
          services.settingService.update({
            // Bugfix: 清空自定义 CA 必须传空串，否则旧 NODE_EXTRA_CA_CERTS 路径会残留。
            httpProxyCaCertPath: normalizedCaCertPath,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedCaCertPath.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxyCaCertPath(normalizedCaCertPath);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [services.settingService, intl],
  );
  const handleDataBaseDirChange = useCallback(
    async (dir: string) => {
      await runSettingsActionAsync({
        featureId: "settings.storage",
        action: "change_data_directory",
        trigger: "button",
        operation: () => services.settingService.updateDataBaseDir(dir || undefined),
        completed: { resultSource: "setting_service", requiresRestart: true },
        failureStage: "data_directory_update",
      });
      // Bugfix: 迁移失败时不能先把本地状态改成失败路径，否则设置页会误显示为已切换。
      setDataBaseDir(dir);
    },
    [services.settingService],
  );
  const handleTaskAutoArchiveEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "toggle_auto_archive",
        trigger: "switch",
        operation: () => services.settingService.update({ taskAutoArchiveEnabled: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTaskAutoArchiveEnabled(enabled);
    },
    [services.settingService],
  );
  const handleTaskAutoArchiveOlderThanDaysChange = useCallback(
    async (days: number) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "change_auto_archive_days",
        trigger: "select",
        operation: () =>
          services.settingService.update({
            taskAutoArchiveOlderThanDays: days,
          }),
        completed: {
          resultSource: "setting_service",
          valueAfter: String(days),
        },
      });
      setTaskAutoArchiveOlderThanDays(days);
    },
    [services.settingService],
  );
  const handleCloseToTrayOnWindowsChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_close_to_tray",
        trigger: "switch",
        operation: () => services.settingService.update({ closeToTrayOnWindows: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      platform.syncAppSettings?.({ closeToTrayOnWindows: enabled });
      setCloseToTrayOnWindows(enabled);
    },
    [services.settingService, platform],
  );
  // keep-awake：走 useSettings 统一写盘 + syncAppSettings，和 Automations/创建页入口共享同一状态源。
  const handleKeepAwakeWhileRunningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_keep_awake",
        trigger: "switch",
        operation: () => updateSharedSettings({ keepAwakeWhileRunning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleDesktopChromiumHardwareAccelerationChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_hardware_acceleration",
        trigger: "switch",
        operation: () =>
          services.settingService.update({
            desktopChromiumHardwareAccelerationEnabled: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setDesktopChromiumHardwareAccelerationEnabled(enabled);
      toast(
        intl.formatMessage({
          id: "settings.desktopChromiumHardwareAccelerationSavedHint",
        }),
      );
    },
    [services.settingService, intl],
  );
  const handleEmbeddedBrowserAllowInsecureCertificatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.browser",
        action: "toggle_insecure_certificates",
        trigger: "switch",
        operation: () =>
          services.settingService.update({
            embeddedBrowserAllowInsecureCertificates: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setEmbeddedBrowserAllowInsecureCertificates(enabled);
      // 证书策略在 main 启动时装到 Session 上，改完必须重启才会换掉 verifyProc。
      toast(
        intl.formatMessage({
          id: "settings.embeddedBrowserAllowInsecureCertificatesSavedHint",
        }),
      );
    },
    [services.settingService, intl],
  );
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_auto_update",
        trigger: "switch",
        operation: () => updateSharedSettings({ autoDownloadAndInstallUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setAutoDownloadAndInstallUpdates(enabled);
    },
    [updateSharedSettings],
  );
  const handleMessageStreamShowReasoningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_reasoning",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowReasoning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowReasoning(enabled);
    },
    [updateSharedSettings],
  );
  const handleMessageStreamShowTodosChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_todos",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowTodos: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowTodos(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingExploreEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_explore_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingExploreEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingExploreEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingTerminalEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_terminal_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingTerminalEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingTerminalEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingChangesEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_changes_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingChangesEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingChangesEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleZCodeInteractionBehaviorChange = useCallback(
    async (behavior: ZCodeInteractionBehavior) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "change_interaction_behavior",
        trigger: "select",
        operation: () => updateSharedSettings({ zcodeInteractionBehavior: behavior }),
        completed: { resultSource: "shared_settings", valueAfter: behavior },
      });
      setZCodeInteractionBehavior(behavior);
    },
    [updateSharedSettings],
  );
  const handleFooterLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        runUserAction({
          input: {
            featureId: "settings.locale",
            action: "change_locale",
            trigger: "select",
          },
          operation: () => setLocalePreference("system"),
          completed: { resultSource: "local_commit", valueAfter: "system" },
          failureStage: "local_commit",
        });
        return;
      }
      if (value === "zh-CN" || value === "en-US") {
        runUserAction({
          input: {
            featureId: "settings.locale",
            action: "change_locale",
            trigger: "select",
          },
          operation: () => setLocalePreference(value as Locale),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setLocalePreference],
  );
  const handleFooterThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        runUserAction({
          input: {
            featureId: "settings.appearance",
            action: "change_theme",
            trigger: "select",
          },
          operation: () => setTheme(value as Theme),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setTheme],
  );
  const handleCodePreviewSettingsChange = useCallback(
    (patch: Parameters<typeof setCodePreviewSettings>[0]) => {
      const [key] = Object.keys(patch);
      const action =
        key === "lightTheme"
          ? "change_code_light_theme"
          : key === "darkTheme"
            ? "change_code_dark_theme"
            : key === "showLineNumbers"
              ? "toggle_code_line_numbers"
              : key === "wrapLongLines"
                ? "toggle_code_line_wrap"
                : "change_code_font_size";
      const value = Object.values(patch)[0];
      return runUserAction({
        input: { featureId: "settings.appearance", action, trigger: "select" },
        operation: () => setCodePreviewSettings(patch),
        completed: {
          resultSource: "local_commit",
          ...(typeof value === "boolean"
            ? {
                stateAfter: value ? ("enabled" as const) : ("disabled" as const),
              }
            : { valueAfter: String(value) }),
        },
        failureStage: "local_commit",
      });
    },
    [setCodePreviewSettings],
  );
  // [leo] 导航搜索：分区 + 扩展 tab + 常规里的设置行，见 docs/specs/leo-settings-ia.md。
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const [settingsSearchHighlight, setSettingsSearchHighlight] = useState(0);
  const [pendingSearchRowId, setPendingSearchRowId] = useState<string | null>(null);
  const settingsSearchInputRef = useRef<HTMLInputElement>(null);
  const settingsSearchCandidates = useMemo(
    () =>
      buildSettingsSearchCandidates({
        config: settingsPageConfig,
        formatMessage: (id) => intl.formatMessage({ id }),
        isDesktop: Boolean(isDesktop),
        isWindowsDesktop: Boolean(isWindowsDesktop),
        isWindowsHost: hostPlatform === "win32",
      }),
    [hostPlatform, intl, isDesktop, isWindowsDesktop, settingsPageConfig],
  );
  const settingsSearchResults = useMemo(
    () => filterSettingsSearchCandidates(settingsSearchQuery, settingsSearchCandidates),
    [settingsSearchCandidates, settingsSearchQuery],
  );
  const isSettingsSearching = settingsSearchQuery.trim().length > 0;
  const openSettingsSearchResult = useCallback(
    (result: SettingsSearchCandidate) => {
      runUserAction({
        input: {
          featureId: "settings.navigation",
          action: "open_section",
          trigger: "keyboard",
        },
        operation: () => {
          setPluginNavigationOrigin(undefined);
          setSettingsSectionNavigationVersion((version) => version + 1);
          setActiveSettingsSection(result.sectionId);
          setPendingSearchRowId(result.rowId ?? null);
          setSettingsSearchQuery("");
          setSettingsSearchHighlight(0);
        },
        completed: {
          resultSource: "local_commit",
          sectionId: result.sectionId,
        },
        failureStage: "navigation_commit",
      });
    },
    [setActiveSettingsSection],
  );
  const handleSettingsSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (settingsSearchQuery) {
          setSettingsSearchQuery("");
          setSettingsSearchHighlight(0);
        } else {
          event.currentTarget.blur();
        }
        return;
      }
      if (!isSettingsSearching || settingsSearchResults.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSettingsSearchHighlight(
          (current) =>
            (current + step + settingsSearchResults.length) % settingsSearchResults.length,
        );
        return;
      }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const result =
          settingsSearchResults[
            Math.min(settingsSearchHighlight, settingsSearchResults.length - 1)
          ];
        if (result) openSettingsSearchResult(result);
      }
    },
    [
      isSettingsSearching,
      openSettingsSearchResult,
      settingsSearchHighlight,
      settingsSearchQuery,
      settingsSearchResults,
    ],
  );
  useEffect(() => {
    if (!pendingSearchRowId || activeSection !== "general") return;
    // 常规页渲染完成后再定位，命中行短暂高亮。高亮移除计时器独立于本 effect，
    // 因为下面清空 pendingSearchRowId 会触发 cleanup，不能顺带把高亮停在半路。
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-settings-row-id="${pendingSearchRowId}"]`,
      );
      setPendingSearchRowId(null);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.dataset.searchHit = "true";
      setTimeout(() => {
        delete row.dataset.searchHit;
      }, 1600);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSection, pendingSearchRowId]);
  const isExtensionSection = extensionSections.some((section) => section.id === activeSection);
  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection);
  // 灰度裁决异步到达：sections 列表可能在挂载后变化（如 computerUse 区被灰度移除）。
  // 若用户正停留在被移除的 section，回落到第一个可见区，避免整页 return null。
  useEffect(() => {
    setActiveSection((current) => resolveSettingsSectionForPlatform(current, settingsSections));
  }, [settingsSections]);
  if (!activeSectionMeta) {
    return null;
  }

  const activeSectionLabel = intl.formatMessage({
    id: activeSectionMeta.contentTitleId ?? activeSectionMeta.titleId,
  });
  const settingsBreadcrumbSectionLabel =
    activeSection === "plugin" && pluginNavigationOrigin === "plugin-store"
      ? intl.formatMessage({ id: "workspace.openPluginsSettings" })
      : activeSectionLabel;
  const visibleSettingsBreadcrumbItems =
    settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel
      ? settingsBreadcrumbItems
      : [];
  const hasVisibleSettingsBreadcrumb = visibleSettingsBreadcrumbItems.length >= 2;
  const showActiveSectionTitle =
    !hasVisibleSettingsBreadcrumb ||
    (activeSection === "plugin" && pluginNavigationOrigin === "plugin-store");
  // 扩展的各 tab 共用「扩展」标题与说明；面包屑仍以 tab 名为根，保持详情页层级不变。
  const headerEntry =
    isExtensionSection && extensionsNavEntry && pluginNavigationOrigin !== "plugin-store"
      ? extensionsNavEntry
      : activeSectionMeta;
  const headerTitle =
    headerEntry === activeSectionMeta
      ? activeSectionLabel
      : intl.formatMessage({ id: headerEntry.titleId });
  const headerHint = headerEntry.hintId ? intl.formatMessage({ id: headerEntry.hintId }) : null;
  const activeNavEntryId = resolveSettingsNavEntryId(activeSection);

  return (
    <>
      <DesktopWindowFrame
        title={intl.formatMessage({ id: "settings.title" })}
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div
          data-testid={TID_SETTINGS_PAGE}
          data-active-section={activeSection}
          // 隐式 auto 行会按 Memory viewer 的内容高度撑出窗口，随后被 DesktopWindowFrame 裁切且没有滚动条。
          // 固定为单个 minmax(0, 1fr) 行，让普通设置页和内部滚动 viewer 都以窗口剩余高度为边界。
          className="relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)]"
        >
          {isWindowsDesktop ? <WindowsTopLeftLogo /> : null}

          {usesInlineWindowControls ? (
            <div className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center gap-0.5 px-2 pointer-events-auto [app-region:no-drag]">
              {/* Bug 原因：Windows/Linux 设置页仍保留旧 caption 下箭头，与主界面和 macOS 的帮助入口不一致。
                  统一复用问号帮助按钮，并让它在普通 flex 流中紧邻自绘窗控。
                  Settings 的独立标题层还需计入 4px 外层留白和 1px 边框，才能与 Workspace 控制组对齐。 */}
              <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} />
              <DesktopWindowControls />
            </div>
          ) : null}
          <aside className="min-w-0">
            <div className="flex h-full flex-col">
              <div className="h-12 [app-region:drag]"></div>
              <div className="px-2 pb-3 pt-3">
                {onBack ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "workspace.backToWorkspace",
                    })}
                    side="right"
                    align="center"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      data-testid={TID_SETTINGS_BACK_BUTTON}
                      aria-label={intl.formatMessage({
                        id: "workspace.backToWorkspace",
                      })}
                      className="m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl px-1.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground max-lg:m-1 max-lg:size-10 max-lg:justify-center max-lg:px-0"
                      onClick={() => {
                        runUserAction({
                          input: {
                            featureId: "settings.navigation",
                            action: "back_to_workspace",
                            trigger: "button",
                          },
                          operation: () => {
                            if (pluginNavigationOrigin === "plugin-store") {
                              requestPluginStoreOpen("user");
                            }
                            onBack?.();
                          },
                          completed: { resultSource: "local_commit" },
                          failureStage: "navigation_commit",
                        });
                      }}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="max-lg:sr-only">
                        {intl.formatMessage({
                          id: "workspace.backToWorkspace",
                        })}
                      </span>
                    </Button>
                  </ControlHintTooltip>
                ) : null}

                {/* <div className={onBack ? "mt-5" : "pt-2"}>
                    <h1 className="flex items-center gap-2 px-2.5 text-ui-lg font-medium text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.title" })}
                    </h1>
                  </div> */}
              </div>

              <nav
                aria-label={intl.formatMessage({ id: "settings.navLabel" })}
                // [leo] 窗口矮时（如 720 高）导航下半段被底栏挡住、看不出还能滚：组间距收紧一档，
                // 并在还有内容时给底边加渐隐（leo-scroll-fade，见 leo-skin.css）。
                className="leo-scroll-fade flex-1 overflow-y-auto px-2 pb-3"
              >
                <div className="px-0.5 pb-3 max-lg:hidden">
                  <SettingsSearchInput
                    ref={settingsSearchInputRef}
                    value={settingsSearchQuery}
                    placeholder={intl.formatMessage({
                      id: "settings.navSearch.placeholder",
                    })}
                    aria-label={intl.formatMessage({
                      id: "settings.navSearch.placeholder",
                    })}
                    aria-controls="settings-nav-search-results"
                    aria-activedescendant={
                      isSettingsSearching && settingsSearchResults[settingsSearchHighlight]
                        ? `settings-nav-search-${settingsSearchResults[settingsSearchHighlight].key}`
                        : undefined
                    }
                    data-testid={TID_SETTINGS_NAV_SEARCH_INPUT}
                    clearLabel={intl.formatMessage({
                      id: "settings.navSearch.clear",
                    })}
                    className="h-7 rounded-lg text-ui-base"
                    onChange={(event) => {
                      setSettingsSearchQuery(event.currentTarget.value);
                      setSettingsSearchHighlight(0);
                    }}
                    onKeyDown={handleSettingsSearchKeyDown}
                    onClear={() => {
                      setSettingsSearchQuery("");
                      setSettingsSearchHighlight(0);
                      settingsSearchInputRef.current?.focus();
                    }}
                  />
                </div>
                {isSettingsSearching ? (
                  <div
                    id="settings-nav-search-results"
                    role="listbox"
                    aria-label={intl.formatMessage({
                      id: "settings.navSearch.placeholder",
                    })}
                    className="space-y-0.5 max-lg:hidden"
                  >
                    {settingsSearchResults.length === 0 ? (
                      <div className="px-2.5 py-1 text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.navSearch.empty" })}
                      </div>
                    ) : (
                      settingsSearchResults.map((result, index) => (
                        <button
                          key={result.key}
                          id={`settings-nav-search-${result.key}`}
                          type="button"
                          role="option"
                          aria-selected={index === settingsSearchHighlight}
                          tabIndex={-1}
                          data-testid={testId(TID_SETTINGS_NAV_SEARCH_RESULT, result.key)}
                          className={cn(
                            "flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors",
                            index === settingsSearchHighlight
                              ? "bg-surface-hover text-foreground"
                              : "text-foreground hover:bg-surface-hover",
                          )}
                          onMouseEnter={() => setSettingsSearchHighlight(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => openSettingsSearchResult(result)}
                        >
                          <span className="min-w-0 flex-1 truncate text-ui-base">
                            {result.label}
                          </span>
                          {result.context ? (
                            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                              {result.context}
                            </span>
                          ) : null}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
                <div className={cn("space-y-3", isSettingsSearching && "lg:hidden")}>
                  {settingsSectionGroups.map((group, groupIndex) => {
                    const groupLabel = intl.formatMessage({
                      id: group.titleId,
                    });
                    const groupLabelId = `settings-sidebar-group-${group.id}`;

                    return (
                      <div
                        key={group.id}
                        role="group"
                        aria-labelledby={groupLabelId}
                        className={cn(
                          "space-y-0.5",
                          groupIndex > 0 && "max-lg:border-t max-lg:border-border max-lg:pt-3",
                        )}
                      >
                        <div
                          id={groupLabelId}
                          className="px-2.5 pb-0.5 text-ui-xs font-medium text-foreground-subtlest max-lg:sr-only"
                        >
                          {groupLabel}
                        </div>
                        {group.sections.map(({ id, icon: Icon, titleId }) => {
                          const isActive = activeNavEntryId === id;
                          const label = intl.formatMessage({ id: titleId });

                          return (
                            <SettingsSidebarButton
                              key={id}
                              icon={Icon}
                              label={label}
                              active={isActive}
                              aria-current={isActive ? "page" : undefined}
                              data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                              onClick={() => {
                                runUserAction({
                                  input: {
                                    featureId: "settings.navigation",
                                    action: "open_section",
                                    trigger: "button",
                                  },
                                  operation: () => {
                                    setPluginNavigationOrigin(undefined);
                                    setSettingsSectionNavigationVersion((version) => version + 1);
                                    // 已在扩展某个 tab 时再点「扩展」保持当前 tab。
                                    setActiveSettingsSection(
                                      id === "extensions" && isExtensionSection
                                        ? activeSection
                                        : id,
                                    );
                                  },
                                  completed: {
                                    resultSource: "local_commit",
                                    sectionId: id,
                                  },
                                  failureStage: "navigation_commit",
                                });
                              }}
                            >
                              <span className="truncate text-ui-base text-foreground">{label}</span>
                            </SettingsSidebarButton>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </nav>

              <div className="max-lg:hidden">
                <WorkspaceSidebarFooter
                  theme={theme}
                  localeMenuValue={localePreference}
                  onLocaleChange={handleFooterLocaleChange}
                  onThemeChange={handleFooterThemeChange}
                  onSettingsButtonClick={onBack}
                  onUsageClick={handleOpenUsageSettings}
                  onLogin={onLogin}
                  onLogout={onLogout}
                  settingsButtonMode="back"
                  user={user}
                  // 头像菜单是 WorkspaceSidebarFooter 的共享菜单，Settings 场景不能丢失桌面平台能力。
                  // 之前这里没透传 isDesktop，导致同一个头像菜单在设置页缺少界面缩放入口。
                  isDesktop={isDesktop}
                />
              </div>
            </div>
          </aside>

          <section
            data-settings-content-frame="true"
            className={cn(
              "flex min-h-0 flex-col",
              // 桌面平台统一复用主工作区的面板 inset；左侧仍与导航相接，顶部由独立拖拽留白承接。
              isDesktop ? "p-1 pl-0 pt-0" : "p-0",
            )}
          >
            <div
              data-settings-top-inset={isDesktop ? "true" : undefined}
              className={cn("[app-region:drag]", isDesktop && "h-1", isMacDesktop && "max-lg:h-16")}
            />
            <div
              data-settings-panel-frame="true"
              className={cn(
                "relative flex flex-col min-h-0 h-full border border-border bg-background",
                // Windows 设置页已有 4px 外层留白，不再承担系统窗口外沿；圆角与主工作区统一为 5px。
                isWindowsDesktop ? "rounded-[5px]" : "rounded-xl",
              )}
            >
              {!usesInlineWindowControls ? (
                <div
                  className={cn(
                    // Settings 使用和 new task 一致的问号定位：在内容面板内定位，外层让出自绘窗口按钮区，内层保持 top-2.5/right-2.5。
                    "absolute top-0 z-50 h-10 w-10 pointer-events-auto [app-region:no-drag]",
                    "right-0",
                  )}
                >
                  <div className="absolute right-2.5 top-2.5 pointer-events-auto [app-region:no-drag]">
                    <WorkspaceHelpMenuButton
                      className="relative z-50 [app-region:no-drag]"
                      isDesktop={Boolean(isDesktop)}
                    />
                  </div>
                </div>
              ) : null}
              <SettingsBreadcrumbProvider
                onItemsChange={setSettingsBreadcrumbItems}
                sectionLabel={settingsBreadcrumbSectionLabel}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0">
                    <div
                      // Settings 窄布局会像左侧导航一样在 max-lg 收成 icon rail。
                      // 此时外层已经提供 max-lg:h-16 的顶部拖拽/避让区，内层 h-10 再保留会把内容额外压低。
                      // Electron 的 drag 区不能和右上角帮助/窗口按钮命中区域重叠；
                      // 这里把右侧按钮区域从拖拽条里让出来，避免真实鼠标点击被标题栏拖拽吞掉。
                      // Windows/Linux 设置页共同避开右上角菜单与内联窗控组。

                      className={cn(
                        "min-w-0 flex-1 [app-region:drag]",
                        // 四个 28px 按钮、组内 2px 间距和左右 8px padding，共 134px。
                        usesInlineWindowControls ? "mr-[134px]" : "mr-12",
                      )}
                    >
                      <SettingsHeaderBreadcrumb
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                        items={visibleSettingsBreadcrumbItems}
                      />
                    </div>
                  </div>
                  <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                    <div
                      className={cn(
                        SETTINGS_FRAME_CONTENT_CLASSNAME,
                        "flex flex-col gap-6",
                        isMacDesktop && "pt-0",
                        // isWindowsDesktop && "pt-12",
                      )}
                    >
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex min-w-0 flex-wrap items-center gap-3">
                            {showActiveSectionTitle ? (
                              <h2 className="text-ui-xl font-semibold tracking-tight text-foreground">
                                {headerTitle}
                              </h2>
                            ) : null}
                            {!hasVisibleSettingsBreadcrumb && activeSectionMeta.titleBadgeId ? (
                              <span className="inline-flex h-6 items-center rounded-full border border-sky-500 px-2 text-ui-xs font-semibold tracking-normal text-sky-500 dark:border-sky-400 dark:text-sky-400">
                                {intl.formatMessage({
                                  id: activeSectionMeta.titleBadgeId,
                                })}
                              </span>
                            ) : null}
                            {/* [leo] 使用统计只保留本机「应用用量」。 */}
                            {activeSection === "usage" ? <SettingsUsageProviderTabs /> : null}
                          </div>
                        </div>
                        {/* [leo] 常规页标题下原有一个只回显界面语言的徽标,和下面的「界面语言」选项重复,去掉。 */}
                        {showActiveSectionTitle && headerHint ? (
                          <p className="mt-1 text-ui-sm text-foreground-subtle">{headerHint}</p>
                        ) : null}
                        {headerEntry !== activeSectionMeta && !hasVisibleSettingsBreadcrumb ? (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {extensionSections.map((tab) => (
                              <SegmentPill
                                key={tab.id}
                                active={activeSection === tab.id}
                                label={intl.formatMessage({ id: tab.titleId })}
                                testId={testId(TID_SETTINGS_EXTENSIONS_TAB, tab.id)}
                                onClick={() => {
                                  runUserAction({
                                    input: {
                                      featureId: "settings.navigation",
                                      action: "open_section",
                                      trigger: "button",
                                    },
                                    operation: () => {
                                      setSettingsSectionNavigationVersion((version) => version + 1);
                                      setActiveSettingsSection(tab.id);
                                    },
                                    completed: {
                                      resultSource: "local_commit",
                                      sectionId: tab.id,
                                    },
                                    failureStage: "navigation_commit",
                                  });
                                }}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="space-y-8">
                        {activeSection === "general" ? (
                          <GeneralSectionContent
                            localePreference={localePreference}
                            isDesktop={isDesktop}
                            isWindowsDesktop={isWindowsDesktop}
                            isLinuxDesktop={isLinuxDesktop}
                            linuxCloseToTray={linuxCloseToTray}
                            platform={platform}
                            notificationEnabled={notificationEnabled}
                            notificationSoundEnabled={notificationSoundEnabled}
                            closeToTrayOnWindows={closeToTrayOnWindows}
                            keepAwakeWhileRunning={sharedSettings?.keepAwakeWhileRunning ?? false}
                            desktopChromiumHardwareAccelerationEnabled={
                              desktopChromiumHardwareAccelerationEnabled
                            }
                            autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
                            dataBaseDir={dataBaseDir}
                            terminalInheritSystemProfile={terminalInheritSystemProfile}
                            terminalFontFamily={terminalFontFamily}
                            integratedTerminalShell={integratedTerminalShell}
                            integratedTerminalShellOptions={integratedTerminalShellOptions}
                            nativeSearchEnhancementsEnabled={nativeSearchEnhancementsEnabled}
                            httpProxy={httpProxy}
                            httpProxyNoProxy={httpProxyNoProxy}
                            httpProxyCaCertPath={httpProxyCaCertPath}
                            defaultHomeDir={defaultHomeDir}
                            showIntegratedTerminalShell={hostPlatform === "win32"}
                            setLocalePreference={handleFooterLocaleChange}
                            setNotificationEnabled={(enabled) =>
                              runUserAction({
                                input: {
                                  featureId: "settings.notification",
                                  action: "toggle_notification",
                                  trigger: "switch",
                                },
                                operation: () => setNotificationEnabled(enabled),
                                completed: {
                                  resultSource: "local_commit",
                                  stateAfter: enabled ? "enabled" : "disabled",
                                },
                                failureStage: "local_commit",
                              })
                            }
                            setNotificationSoundEnabled={(enabled) =>
                              runUserAction({
                                input: {
                                  featureId: "settings.notification",
                                  action: "toggle_notification_sound",
                                  trigger: "switch",
                                },
                                operation: () => setNotificationSoundEnabled(enabled),
                                completed: {
                                  resultSource: "local_commit",
                                  stateAfter: enabled ? "enabled" : "disabled",
                                },
                                failureStage: "local_commit",
                              })
                            }
                            taskAutoArchiveEnabled={taskAutoArchiveEnabled}
                            taskAutoArchiveOlderThanDays={taskAutoArchiveOlderThanDays}
                            messageStreamShowReasoning={messageStreamShowReasoning}
                            messageStreamShowTodos={messageStreamShowTodos}
                            toolGroupingExploreEnabled={toolGroupingExploreEnabled}
                            toolGroupingTerminalEnabled={toolGroupingTerminalEnabled}
                            toolGroupingChangesEnabled={toolGroupingChangesEnabled}
                            zcodeInteractionBehavior={zcodeInteractionBehavior}
                            askUserQuestionAutoResolutionEnabled={
                              askUserQuestionAutoResolutionEnabled
                            }
                            modelIoFullRetentionEnabled={modelIoFullRetentionEnabled}
                            onDataBaseDirChange={handleDataBaseDirChange}
                            onSelectDataBaseDir={selectDirectory}
                            onTerminalInheritSystemProfileChange={
                              handleTerminalInheritSystemProfileChange
                            }
                            onTerminalFontFamilyChange={handleTerminalFontFamilyChange}
                            onIntegratedTerminalShellChange={handleIntegratedTerminalShellChange}
                            onNativeSearchEnhancementsEnabledChange={
                              handleNativeSearchEnhancementsEnabledChange
                            }
                            onModelIoFullRetentionEnabledChange={
                              handleModelIoFullRetentionEnabledChange
                            }
                            onHttpProxyChange={handleHttpProxyChange}
                            onHttpProxyNoProxyChange={handleHttpProxyNoProxyChange}
                            onHttpProxyCaCertPathChange={handleHttpProxyCaCertPathChange}
                            onTaskAutoArchiveEnabledChange={handleTaskAutoArchiveEnabledChange}
                            onTaskAutoArchiveOlderThanDaysChange={
                              handleTaskAutoArchiveOlderThanDaysChange
                            }
                            onCloseToTrayOnWindowsChange={handleCloseToTrayOnWindowsChange}
                            onKeepAwakeWhileRunningChange={handleKeepAwakeWhileRunningChange}
                            onDesktopChromiumHardwareAccelerationChange={
                              handleDesktopChromiumHardwareAccelerationChange
                            }
                            onAutoDownloadAndInstallUpdatesChange={
                              handleAutoDownloadAndInstallUpdatesChange
                            }
                            onMessageStreamShowReasoningChange={
                              handleMessageStreamShowReasoningChange
                            }
                            onMessageStreamShowTodosChange={handleMessageStreamShowTodosChange}
                            onToolGroupingExploreEnabledChange={
                              handleToolGroupingExploreEnabledChange
                            }
                            onToolGroupingTerminalEnabledChange={
                              handleToolGroupingTerminalEnabledChange
                            }
                            onToolGroupingChangesEnabledChange={
                              handleToolGroupingChangesEnabledChange
                            }
                            onZCodeInteractionBehaviorChange={handleZCodeInteractionBehaviorChange}
                            onAskUserQuestionAutoResolutionEnabledChange={
                              handleAskUserQuestionAutoResolutionEnabledChange
                            }
                            onOpenOnboardingDialog={() =>
                              runUserAction({
                                input: {
                                  featureId: "settings.navigation",
                                  action: "open_onboarding",
                                  trigger: "button",
                                },
                                operation: requestOnboardingDialog,
                                completed: { resultSource: "local_commit" },
                                failureStage: "dialog_open",
                              })
                            }
                          />
                        ) : activeSection === "appearance" ? (
                          <AppearanceSectionContent
                            codePreviewSettings={codePreviewSettings}
                            setCodePreviewSettings={handleCodePreviewSettingsChange}
                            theme={theme}
                            setTheme={(nextTheme) => handleFooterThemeChange(nextTheme)}
                            uiFontSizePx={uiFontSizePx}
                            setUiFontSizePx={(fontSizePx) =>
                              runUserAction({
                                input: {
                                  featureId: "settings.appearance",
                                  action: "change_ui_font_size",
                                  trigger: "keyboard",
                                },
                                operation: () => setUiFontSizePx(fontSizePx),
                                completed: {
                                  resultSource: "local_commit",
                                  valueAfter: String(fontSizePx),
                                },
                                failureStage: "local_commit",
                              })
                            }
                          />
                        ) : activeSection === "shortcuts" ? (
                          <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
                        ) : activeSection === "modelProvider" ? (
                          <ServiceProvider services={localHostServices}>
                            {/* 模型配置属于本机全局事实源；激活远端 workspace 时也不能注入远端 Host。 */}
                            <ModelProviderSection
                              workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
                              connectivityWorkspacePath={
                                localModelProviderConnectivityWorkspacePath
                              }
                              connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}
                              pendingModelProviderTarget={pendingModelProviderTarget}
                              onConsumePendingModelProviderTarget={() =>
                                setPendingModelProviderTarget(undefined)
                              }
                            />
                          </ServiceProvider>
                        ) : activeSection === "memory" ? (
                          <ServiceProvider services={localHostServices}>
                            {/* Memory catalog 始终使用本地 Host，避免远程 workspace 误读本机数据。 */}
                            <MemorySettingsSection
                              memoryEnabled={memoryEnabled}
                              memoryService={localHostServices.memoryService}
                              onMemoryEnabledChange={handleMemoryEnabledChange}
                              projectMemoryViewerAvailable={Boolean(isDesktop)}
                              workspaceDisplayNames={memoryWorkspaceDisplayNames}
                            />
                          </ServiceProvider>
                        ) : activeSection === "plugin" ? (
                          <PluginsSection
                            key={`plugin:${settingsSectionNavigationVersion}`}
                            isDesktop={Boolean(isDesktop)}
                            isMacDesktop={Boolean(isMacDesktop)}
                            isWindowsDesktop={Boolean(isWindowsDesktop)}
                            initialTab={pluginTab}
                            initialScopeKey={pluginScopeKey}
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            showMarketplaceBreadcrumb={pluginNavigationOrigin === "plugin-store"}
                            onCreateTask={onCreateTask}
                            onOpenPluginStore={(_returnScopeKey, intent) => {
                              // 添加市场与浏览插件都先离开设置层，再显示商店。
                              requestPluginStoreOpen({
                                returnScopeKey: "user",
                                intent,
                              });
                              onBack?.();
                            }}
                          />
                        ) : activeSection === "mcp" ? (
                          <PluginsSection
                            key={`mcp:${settingsSectionNavigationVersion}`}
                            mode="mcp"
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            onCreateTask={onCreateTask}
                            onOpenPluginStore={(_returnScopeKey, intent) => {
                              // 添加市场与浏览插件都先离开设置层，再显示商店。
                              requestPluginStoreOpen({
                                returnScopeKey: "user",
                                intent,
                              });
                              onBack?.();
                            }}
                          />
                        ) : activeSection === "skill" ? (
                          <PluginsSection
                            key={`skill:${settingsSectionNavigationVersion}`}
                            mode="skill"
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            onCreateTask={onCreateTask}
                            onOpenPluginStore={(_returnScopeKey, intent) => {
                              // 添加市场与浏览插件都先离开设置层，再显示商店。
                              requestPluginStoreOpen({
                                returnScopeKey: "user",
                                intent,
                              });
                              onBack?.();
                            }}
                          />
                        ) : activeSection === "migration" ? (
                          <MigrationSection
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            isDesktop={isDesktop}
                          />
                        ) : activeSection === "usage" ? (
                          <UsageStatsSection />
                        ) : activeSection === "subagents" ? (
                          <SubagentsSection
                            onManageModels={handleOpenModelProviderSettings}
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                          />
                        ) : activeSection === "automations" ? (
                          <AutomationsSection
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                          />
                        ) : activeSection === "commands" ? (
                          <PluginsSection
                            mode="command"
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            onCreateTask={onCreateTask}
                            onOpenPluginStore={(_returnScopeKey, intent) => {
                              // 添加市场与浏览插件都先离开设置层，再显示商店。
                              requestPluginStoreOpen({
                                returnScopeKey: "user",
                                intent,
                              });
                              onBack?.();
                            }}
                          />
                        ) : activeSection === "hooks" ? (
                          <HooksSection
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                          />
                        ) : activeSection === "workspaceFileSearch" ? (
                          <WorkspaceFileSearchSection
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                          />
                        ) : activeSection === "browser" ? (
                          <BrowserSettingsSection
                            isDesktop={Boolean(isDesktop)}
                            isWindowsDesktop={isWindowsDesktop}
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            embeddedBrowserAllowInsecureCertificates={
                              embeddedBrowserAllowInsecureCertificates
                            }
                            onEmbeddedBrowserAllowInsecureCertificatesChange={
                              handleEmbeddedBrowserAllowInsecureCertificatesChange
                            }
                          />
                        ) : activeSection === "phone" ? (
                          <LeoPhoneLinkSection />
                        ) : activeSection === "computerUse" ? (
                          // [leo][WP-22] 上游 ComputerUseSection 依赖占位的 zcode-cua（恒为不可用），换成 Peekaboo 权限页。
                          <LeoComputerUseSection />
                        ) : activeSection === "externalAgents" ? (
                          // [leo][WP-21] 外部 agent（ACP）
                          <LeoExternalAgentsSection />
                        ) : null}
                      </div>
                    </div>
                  </main>
                </div>
              </SettingsBreadcrumbProvider>
            </div>
          </section>
        </div>
      </DesktopWindowFrame>
    </>
  );
}

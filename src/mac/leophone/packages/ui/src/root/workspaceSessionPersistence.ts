import type { AppSettings, PersistedWorkspaceSessionEntry } from "@zcode/shared";
import { resolveStartupLocalWorkspaceSessionIndex } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  isWorkspaceTab,
  type RestorableWorkspaceTab,
  type TabStore,
  type TabStoreState,
  type WorkspaceTabState,
} from "@/store/tabStore.js";

type LocalWorkspaceSessionEntry = Extract<PersistedWorkspaceSessionEntry, { kind: "local" }>;

function getRestorableWorkspaceKey(tab: string | RestorableWorkspaceTab): string {
  if (typeof tab === "string") {
    return tab;
  }
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

function isLocalWorkspaceTab(tab: WorkspaceTabState): boolean {
  // LeoBot 已删除 SSH / WSL / Docker 远程工作区：带远程身份的 tab 不再写回 setting.json。
  return !tab.remoteSessionId && !tab.remoteTarget && !tab.workspaceIdentity?.trim();
}

export function buildWorkspacePersistPatch(state: TabStoreState): Partial<AppSettings> {
  const localTabs = state.tabs.filter(isWorkspaceTab).filter(isLocalWorkspaceTab);
  const entries: LocalWorkspaceSessionEntry[] = localTabs.map((tab) => ({
    kind: "local",
    workspacePath: tab.workspacePath,
    ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
  }));
  const activeIndex = state.activeWorkspacePath
    ? localTabs.findIndex((tab) => tab.workspacePath === state.activeWorkspacePath)
    : 0;

  return {
    lastWorkspaceSession: entries,
    lastActiveTabIndex: Math.max(activeIndex, 0),
  };
}

export function restorePersistedWorkspaceSessions({
  settings,
  tabStoreApi,
  unavailableWorkspacePath,
  conversationWorkspacePath,
  restoreMode = "all",
}: {
  settings: AppSettings;
  tabStoreApi: TabStore;
  unavailableWorkspacePath?: string;
  conversationWorkspacePath?: string;
  restoreMode?: "all" | "active-first";
}): { deferredRestore?: () => void } | undefined {
  const persistedSessions = settings.lastWorkspaceSession ?? [];

  if (persistedSessions.length === 0 && !conversationWorkspacePath) {
    return;
  }

  const restoredTabs: Array<string | RestorableWorkspaceTab> = [];
  const seenLocalWorkspacePaths = new Set<string>();
  const activeSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
    persistedSessions,
    settings.lastActiveTabIndex,
  );
  let restoredActiveIndex = 0;
  let canonicalConversationRestoredIndex: number | null = null;
  let shouldActivateCanonicalConversation = false;

  for (const [index, persistedEntry] of persistedSessions.entries()) {
    if (persistedEntry.kind !== "local") {
      // 旧版本可能把 SSH / WSL / Docker 远程标签页(kind: "remote",带 remoteTarget /
      // workspaceIdentity)写进 lastWorkspaceSession。LeoBot 已整体删除远程工作区,
      // 这里静默丢弃:不报错、不恢复成断连 tab、不尝试重连;下一次持久化只写本地项,
      // 旧远程条目随之从 setting.json 消失。
      continue;
    }

    const isStaleConversationWorkspace = Boolean(
      conversationWorkspacePath &&
      persistedEntry.workspacePurpose === "conversation" &&
      persistedEntry.workspacePath !== conversationWorkspacePath,
    );
    if (isStaleConversationWorkspace) {
      // 测试数据根目录或旧 data root 可能把多个 conversation backing path
      // 持久化下来；它们是同一个逻辑“无项目会话”，恢复时必须以 service 给出的
      // canonical path 为准，否则侧栏和定时任务选择器都会出现多个 default。
      logger.warn("[Root] 跳过非 canonical conversation workspace 恢复", {
        workspacePath: persistedEntry.workspacePath,
        conversationWorkspacePath,
      });
      if (index === activeSessionIndex) {
        shouldActivateCanonicalConversation = true;
        if (canonicalConversationRestoredIndex !== null) {
          restoredActiveIndex = canonicalConversationRestoredIndex;
        }
      }
      continue;
    }

    if (seenLocalWorkspacePaths.has(persistedEntry.workspacePath)) {
      logger.warn("[Root] 跳过重复的本地 workspace 恢复", {
        workspacePath: persistedEntry.workspacePath,
      });
      continue;
    }

    const isConversationWorkspace = persistedEntry.workspacePath === conversationWorkspacePath;
    const workspacePurpose = isConversationWorkspace
      ? "conversation"
      : persistedEntry.workspacePurpose;
    const availability =
      !isConversationWorkspace && persistedEntry.workspacePath === unavailableWorkspacePath
        ? "unavailable-local-directory"
        : undefined;
    restoredTabs.push(
      workspacePurpose || availability
        ? {
            workspacePath: persistedEntry.workspacePath,
            workspacePurpose,
            availability,
          }
        : persistedEntry.workspacePath,
    );
    seenLocalWorkspacePaths.add(persistedEntry.workspacePath);
    const restoredIndex = restoredTabs.length - 1;
    if (isConversationWorkspace) {
      canonicalConversationRestoredIndex = restoredIndex;
    }
    if (
      index === activeSessionIndex ||
      (isConversationWorkspace && shouldActivateCanonicalConversation)
    ) {
      restoredActiveIndex = restoredIndex;
    }
  }

  if (conversationWorkspacePath && !seenLocalWorkspacePaths.has(conversationWorkspacePath)) {
    // conversation backing workspace 是 app-owned cwd，旧设置里缺少它时，
    // 侧栏就不会订阅该 scope；若 purpose 丢失又会被当成项目。恢复阶段以 service
    // 解析出的 canonical path 为权威，非激活补建并强制标记 conversation。
    restoredTabs.push({
      workspacePath: conversationWorkspacePath,
      workspacePurpose: "conversation",
    });
    canonicalConversationRestoredIndex = restoredTabs.length - 1;
    if (shouldActivateCanonicalConversation) {
      restoredActiveIndex = canonicalConversationRestoredIndex;
    }
  }

  if (restoredTabs.length === 0) {
    return undefined;
  }

  if (restoreMode === "active-first" && restoredTabs.length > 1) {
    const activeTab = restoredTabs[restoredActiveIndex];
    if (activeTab) {
      const activeWorkspaceKey = getRestorableWorkspaceKey(activeTab);
      logger.info("[Root] 优先恢复 active workspace", {
        deferredCount: restoredTabs.length - 1,
      });
      tabStoreApi.getState().restoreTabs([activeTab], 0);
      return {
        deferredRestore: () => {
          const startupActiveStillOpen = tabStoreApi
            .getState()
            .tabs.filter(isWorkspaceTab)
            .some(
              (tab) => (tab.workspaceIdentity?.trim() || tab.workspacePath) === activeWorkspaceKey,
            );
          // active-first 保存的是旧 settings 快照；idle callback 前用户若关闭 active tab，
          // 直接 complete 会把它从旧快照复活。关闭属于本窗口新意图，补齐时必须排除该 identity。
          const tabsToComplete = startupActiveStillOpen
            ? restoredTabs
            : restoredTabs.filter(
                (restoredTab) => getRestorableWorkspaceKey(restoredTab) !== activeWorkspaceKey,
              );
          logger.info("[Root] 首帧后补齐 inactive workspace", {
            count: tabsToComplete.length - (startupActiveStillOpen ? 1 : 0),
          });
          tabStoreApi.getState().completeTabRestore(tabsToComplete);
        },
      };
    }
  }
  logger.info("[Root] 恢复 workspace 会话", {
    count: restoredTabs.length,
    activeIndex: restoredActiveIndex,
  });
  tabStoreApi.getState().restoreTabs(restoredTabs, restoredActiveIndex);
  return undefined;
}

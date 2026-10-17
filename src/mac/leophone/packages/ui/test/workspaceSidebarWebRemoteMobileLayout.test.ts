// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";

const { setPendingSettingsSectionMock } = vi.hoisted(() => ({
  setPendingSettingsSectionMock: vi.fn(),
}));

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserverMock {
    disconnect() {}
    observe() {}
    unobserve() {}
  },
);

const workspaceTab = {
  id: "tab-1",
  kind: "workspace" as const,
  label: "Project",
  workspacePath: "/tmp/project",
};

const tabStoreState = {
  activeTabId: workspaceTab.id,
  tabs: [workspaceTab],
  expandedWorkspacePaths: new Set([workspaceTab.workspacePath]),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  collapseAllWorkspaceTabs: vi.fn(),
  expandAllWorkspaceTabs: vi.fn(),
  openSettingsTab: vi.fn(),
  reorderWorkspaceTabs: vi.fn(),
  toggleWorkspaceExpanded: vi.fn(),
};

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DragOverlay: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  KeyboardSensor: function KeyboardSensor() {},
  PointerSensor: function PointerSensor() {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    isDragging: false,
    listeners: {},
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
  })),
  verticalListSortingStrategy: {},
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/NewTaskButtonGroup.js", () => ({
  NewTaskButtonGroup: () => createElement("div", { "data-testid": "new-task-button-group" }),
}));

vi.mock("@/TaskSearchDialog.js", () => ({
  TaskSearchDialog: () => null,
}));

vi.mock("@/BotsDialog.js", () => ({
  BotsDialog: () => null,
}));

vi.mock("@/WebRemoteControlTaskIndex.js", () => ({
  WebRemoteControlTaskIndex: ({
    renderBeforePinnedTasks,
  }: {
    renderBeforePinnedTasks?: () => ReactNode;
  }) => createElement("div", { "data-testid": "remote-task-index" }, renderBeforePinnedTasks?.()),
}));

vi.mock("@/WorkspaceArchivedTasksFlatSection.js", () => ({
  WorkspaceArchivedTasksFlatSection: () =>
    createElement("div", { "data-testid": "archived-tasks" }),
}));

vi.mock("@/WorkspacePinnedTasksSection.js", () => ({
  WorkspacePinnedTasksSection: () => createElement("div", { "data-testid": "pinned-tasks" }),
}));

vi.mock("@/WorkspaceTimelineTasksSection.js", () => ({
  WorkspaceTimelineTasksSection: () => createElement("div", { "data-testid": "timeline-tasks" }),
}));

vi.mock("@/WorkspaceGroupedTasksSection.js", () => ({
  WorkspaceGroupedTasksSection: () => createElement("div", { "data-testid": "grouped-tasks" }),
}));

vi.mock("@/WorkspaceSidebarFooter.js", () => ({
  WorkspaceSidebarFooter: () => createElement("footer", { "data-testid": "sidebar-footer" }),
}));

vi.mock("@/SortableWorkspaceSidebar.js", () => ({
  SortableWorkspaceSidebarItem: ({ tab }: { tab: typeof workspaceTab }) =>
    createElement("li", { "data-testid": "workspace-sidebar-item" }, tab.label),
  restrictVerticalDragWithinContainer: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceTaskLists.js", () => ({
  useWorkspaceTaskLists: () => ({
    groups: [],
    loadingByWorkspaceKey: {},
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    localePreference: "en-US",
    setLocalePreference: vi.fn(),
  }),
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  selectWorkspaceZCodeState: () => ({ activeTaskId: "task-1" }),
  useZCodeSessionStore: (selector: (state: { selectDraftProvider: () => void }) => unknown) =>
    selector({ selectDraftProvider: vi.fn() }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: { setTheme: () => void }) => unknown) =>
    selector({ setTheme: vi.fn() }),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof tabStoreState) => unknown) => selector(tabStoreState),
}));

vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({
    openCodingPlanUpgrade: vi.fn(),
  }),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSection: setPendingSettingsSectionMock,
}));

function createSidebarProps(overrides: Record<string, unknown> = {}) {
  return {
    isDesktop: false,
    isWindowsDesktop: false,
    onCancelRemoteProject: vi.fn(async () => {}),
    onConnectRemote: vi.fn(async () => ""),
    onCreateTask: vi.fn(),
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onSelectRemoteProject: vi.fn(async () => {}),
    onSelectTask: vi.fn(),
    selectedProvider: "codex",
    theme: "light",
    user: null,
    webRemoteControlWorkspaceSwitcher: {
      listWorkspaces: vi.fn(async () => ({ tasks: [], workspaces: [] })),
      switchWorkspace: vi.fn(async () => {}),
    },
    workspacePath: workspaceTab.workspacePath,
    ...overrides,
  };
}

async function createSidebarElement(overrides: Record<string, unknown> = {}) {
  const { WorkspaceSidebar } = await import("@/WorkspaceSidebar.js");
  // 快捷键特性后侧栏经 useShortcutCommandLabel → useSettings 读 ServiceContext 与 PlatformContext，
  // 裸渲染需提供最小 ServiceProvider/PlatformProvider（onSettingsChanged 可选，空 platform 即可）
  const { ServiceProvider } = await import("@/hooks/useServices.js");
  const { PlatformProvider } = await import("@/hooks/usePlatform.js");
  const { createSettingsTestServices } = await import("./lib/settingsTestServices.js");

  return createElement(
    ServiceProvider,
    { services: createSettingsTestServices() },
    createElement(
      PlatformProvider,
      { platform: {} as unknown as IPlatformService },
      createElement(
        WorkspaceSidebar,
        createSidebarProps(overrides) as Parameters<typeof WorkspaceSidebar>[0],
      ),
    ),
  );
}

describe("WorkspaceSidebar Web remote mobile layout", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // [leo] Web 远程控制已删除（WorkspaceSidebar 不再有远程手机端导航/远程任务索引），对应的手机滚动区用例随之删除。
  it("opens the workspace plugin marketplace from the home shortcut", async () => {
    const onOpenPluginStore = vi.fn();

    render(await createSidebarElement({ onOpenPluginStore }));
    fireEvent.click(screen.getByRole("button", { name: "workspace.openPluginsSettings" }));

    expect(onOpenPluginStore).toHaveBeenCalledTimes(1);
    expect(setPendingSettingsSectionMock).not.toHaveBeenCalled();
    expect(tabStoreState.openSettingsTab).not.toHaveBeenCalled();
  });

  it("归档视图打开后将关闭按钮的 tooltip label 切换为 Close", async () => {

    render(await createSidebarElement());
    const archiveButton = screen.getByRole("button", {
      name: "workspaceSidebar.toggleArchivedTasks",
    });

    fireEvent.click(archiveButton);

    expect(screen.getByRole("button", { name: "common.close" })).toBe(archiveButton);
  });

  it("places plugins immediately after automations on the desktop home sidebar", async () => {

    render(await createSidebarElement({ webRemoteControlWorkspaceSwitcher: undefined }));
    const automationsButton = screen.getByRole("button", {
      name: "workspace.openScheduledSettings",
    });
    const pluginsButton = screen.getByRole("button", {
      name: "workspace.openPluginsSettings",
    });

    expect(pluginsButton.querySelector("svg")?.classList.contains("lucide-blocks")).toBe(true);
    expect(
      automationsButton.compareDocumentPosition(pluginsButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not keep the removed task toolbar search state", () => {
    const sidebarSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebar.tsx"),
      "utf8",
    );

    expect(sidebarSource).not.toContain("webRemoteTaskSearchOpen");
    expect(sidebarSource).not.toContain("webRemoteTaskSearchQuery");
  });
});

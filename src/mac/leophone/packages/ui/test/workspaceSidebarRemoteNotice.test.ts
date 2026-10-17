import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const {
  archiveWorkspaceTasks,
  confirmDialog,
  releaseWorkspacePreparation,
  toast,
  workspaceRuntimeState,
} = vi.hoisted(() => ({
  archiveWorkspaceTasks: vi.fn(async () => []),
  confirmDialog: vi.fn(async () => true),
  releaseWorkspacePreparation: vi.fn(async () => undefined),
  toast: vi.fn(),
  workspaceRuntimeState: {
    draftStatus: "idle",
    taskRuntimeByTaskId: {} as Record<string, { status: string }>,
  },
}));

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    CheckIcon: createIcon("check"),
    CircleAlert: createIcon("circle-alert"),
    Cloud: createIcon("cloud"),
    CopyIcon: createIcon("copy"),
    Ellipsis: createIcon("ellipsis"),
    ListTree: createIcon("list-tree"),
    Loader2: createIcon("loader-2"),
    Folder: createIcon("folder"),
    FolderOpen: createIcon("folder-open"),
    House: createIcon("house"),
    InfoIcon: createIcon("info"),
    LoaderCircle: createIcon("loader"),
    RefreshCwIcon: createIcon("refresh"),
    MessageCirclePlus: createIcon("message-circle-plus"),
    UploadCloud: createIcon("upload-cloud"),
    XIcon: createIcon("x"),
  };
});

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => confirmDialog,
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, className, ...props }: { children: unknown; className?: string }) =>
    createElement("button", { className, ...props }, children),
  buttonVariants: () => "button-variants",
}));

vi.mock("@/components/ui/collapsible.js", () => ({
  Collapsible: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "collapsible" }, children),
  CollapsibleContent: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "collapsible-content" }, children),
  CollapsibleTrigger: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "collapsible-trigger" }, children),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuContent: ({
    children,
    onClick,
  }: {
    children: unknown;
    onClick?: (event: { stopPropagation(): void }) => void;
  }) => {
    capturedWorkspaceMenuClick = onClick ?? null;
    return createElement("div", { "data-testid": "dropdown-menu-content" }, children);
  },
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children: unknown;
    onSelect?: (event: { preventDefault(): void }) => void;
    "data-testid"?: string;
  }) => {
    if (onSelect && props["data-testid"]?.startsWith("workspace-close-")) {
      capturedWorkspaceRemoveSelect = onSelect;
    }
    return createElement("div", { "data-testid": "dropdown-menu-item", ...props }, children);
  },
  DropdownMenuTrigger: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "dropdown-menu-trigger" }, children),
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "tooltip-provider" }, children),
  Tooltip: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "tooltip-root" }, children),
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "tooltip-content" }, children),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: unknown; title: string }) =>
    createElement("div", { "data-title": title }, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        const messages: Record<string, string> = {
          "common.more": "更多",
          "workspaceSidebar.remove": "移除工作区",
          "workspaceSidebar.unavailableLocalDirectory":
            "工作区目录不存在或无法访问，当前仅可查看历史记录。恢复该目录后重启 ZCode 即可继续使用。",
          "taskList.newThread": "新建任务",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

vi.mock("@/TaskList.js", () => ({
  TaskList: () => createElement("div", { "data-testid": "task-list" }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({
    fileService: {
      readdir: async () => [],
    },
    skillSyncService: {},
    mcpSyncService: {},
    pluginSyncService: {},
  }),
  useWorkspaceServices: () => ({
    skillSyncService: {},
    mcpSyncService: {},
    pluginSyncService: {},
    skillsService: {
      list: async () => [],
    },
    legacyTaskService: {
      renameTask: async () => ({}),
      setTaskPinned: async () => ({}),
      archiveTask: async () => ({}),
      archiveWorkspaceTasks,
      setTaskUnread: async () => ({}),
    },
    zcodeTaskService: {
      releaseWorkspacePreparation,
    },
  }),
}));

vi.mock("@/store/taskQueryCacheStore.js", () => ({
  applyTaskQueryCacheMutation: () => {},
  invalidateTaskQueryCacheByScopes: () => {},
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      startDraft: () => {},
      removeTaskState: () => {},
      upsertOptimisticTaskListItem: () => {},
      removeOptimisticTaskListItem: () => {},
      setTaskUnreadIndicator: () => {},
    }),
  selectWorkspaceZCodeState: () => ({
    activeTaskId: null,
    draftRuntime: { status: workspaceRuntimeState.draftStatus, error: null },
    taskRuntimeByTaskId: workspaceRuntimeState.taskRuntimeByTaskId,
    selectedProvider: "codex",
  }),
}));

let capturedWorkspaceRemoveSelect: ((event: { preventDefault(): void }) => void) | null = null;
let capturedWorkspaceMenuClick: ((event: { stopPropagation(): void }) => void) | null = null;

function createWorkspaceTab(overrides: Partial<WorkspaceTabState> = {}): WorkspaceTabState {
  return {
    id: "workspace-local",
    kind: "workspace",
    label: "project",
    workspacePath: "/workspace/project",
    ...overrides,
  };
}

function renderWorkspaceItem(params?: {
  tab?: WorkspaceTabState;
  onOpenFileTree?: Parameters<typeof WorkspaceSidebarItem>[0]["onOpenFileTree"];
  closeTab?: Parameters<typeof WorkspaceSidebarItem>[0]["closeTab"];
  isExpanded?: boolean;
  taskListHasUnread?: boolean;
  taskListLiveWorkflowCount?: number;
  taskItems?: Parameters<typeof WorkspaceSidebarItem>[0]["taskItems"];
}) {
  const tab = params?.tab ?? createWorkspaceTab();

  return renderToStaticMarkup(
    createElement(WorkspaceSidebarItem, {
      tab,
      isActiveWorkspace: false,
      isExpanded: params?.isExpanded ?? false,
      activateTab: () => {},
      closeTab: params?.closeTab ?? (() => {}),
      toggleWorkspaceExpanded: () => {},
      onSelectTask: () => {},
      onStartDraftInWorkspace: () => {},
      taskItems: params?.taskItems ?? [],
      taskListLoading: false,
      taskListHasMore: false,
      taskListHasUnread: params?.taskListHasUnread ?? false,
      taskListLiveWorkflowCount: params?.taskListLiveWorkflowCount ?? 0,
      onShowMoreTasks: () => {},
      onOpenFileTree: params?.onOpenFileTree,
    }),
  );
}

import { WorkspaceSidebarItem } from "@/WorkspaceSidebarItem.js";

describe("WorkspaceSidebarItem", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
    });
    archiveWorkspaceTasks.mockClear();
    confirmDialog.mockClear();
    confirmDialog.mockResolvedValue(true);
    releaseWorkspacePreparation.mockClear();
    toast.mockClear();
    workspaceRuntimeState.draftStatus = "idle";
    workspaceRuntimeState.taskRuntimeByTaskId = {};
    capturedWorkspaceRemoveSelect = null;
    capturedWorkspaceMenuClick = null;
  });

  it("workspace 收起时显示聚合未读蓝点，展开时只保留 task 行提示", () => {
    const collapsedHtml = renderWorkspaceItem({ taskListHasUnread: true });
    const expandedHtml = renderWorkspaceItem({ isExpanded: true, taskListHasUnread: true });

    expect(collapsedHtml).toContain('data-workspace-unread-indicator="true"');
    expect(collapsedHtml).toContain("bg-sky-500 dark:bg-sky-400");
    expect(expandedHtml).not.toContain('data-workspace-unread-indicator="true"');
  });

  it("workspace 收起时在未读点旁显示在跑工作流的脉冲灯，>1 带数量；展开时不显示", () => {
    const one = renderWorkspaceItem({ taskListLiveWorkflowCount: 1 });
    const three = renderWorkspaceItem({ taskListHasUnread: true, taskListLiveWorkflowCount: 3 });
    const expanded = renderWorkspaceItem({ isExpanded: true, taskListLiveWorkflowCount: 2 });
    const none = renderWorkspaceItem();

    expect(one).toContain('data-workspace-workflow-indicator="true"');
    expect(one).toContain('data-count="1"');
    expect(one).toContain("animate-pulse bg-warning");
    expect(three).toContain('data-workspace-unread-indicator="true"');
    expect(three).toContain('data-count="3"');
    expect(three).toMatch(/data-count="3"[^>]*>.*3</);
    expect(expanded).not.toContain("data-workspace-workflow-indicator");
    expect(none).not.toContain("data-workspace-workflow-indicator");
  });

  it("失效的本地 workspace 标题后显示红色告警并禁用目录操作", () => {
    const html = renderWorkspaceItem({
      tab: createWorkspaceTab({
        id: "workspace-local-missing",
        label: "missing-project",
        workspacePath: "/workspace/missing-project",
        availability: "unavailable-local-directory",
      }),
      onOpenFileTree: () => {},
    });

    expect(html).toContain('data-icon="circle-alert"');
    expect(html).toContain("size-3.5 text-destructive");
    expect(html).toContain(
      "工作区目录不存在或无法访问，当前仅可查看历史记录。恢复该目录后重启 ZCode 即可继续使用。",
    );
    expect(html).toContain('data-icon="list-tree"');
    expect(html).toContain('disabled=""');
  });

  it("本地项目显示 file tree 入口", () => {
    const html = renderWorkspaceItem({ onOpenFileTree: () => {} });

    expect(html).toContain('data-icon="list-tree"');
    expect(html).toContain("workspaceSidebar.showFileTree");
  });

  it("移除 workspace 会释放 runtime 且不批量归档已有 task", async () => {
    const closeTab = vi.fn();

    renderWorkspaceItem({ closeTab });
    await capturedWorkspaceRemoveSelect?.({
      preventDefault: () => {},
    });
    await Promise.resolve();

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalledWith("workspace-local");
    expect(releaseWorkspacePreparation).toHaveBeenCalledWith({
      workspacePath: "/workspace/project",
    });
    expect(archiveWorkspaceTasks).not.toHaveBeenCalled();
  });

  it("运行中 workspace 移除被取消时不关闭 tab 也不释放 runtime", async () => {
    const closeTab = vi.fn();
    confirmDialog.mockResolvedValue(false);
    workspaceRuntimeState.taskRuntimeByTaskId = { task_running: { status: "streaming" } };

    renderWorkspaceItem({
      closeTab,
      taskItems: [
        {
          taskId: "task_running",
          traceId: "trace_running",
          title: "running task",
          workspacePath: "/workspace/project",
          createdAt: 1,
          updatedAt: 1,
          mode: "agent",
          status: "running",
        },
      ],
    });
    await capturedWorkspaceRemoveSelect?.({
      preventDefault: () => {},
    });
    await Promise.resolve();

    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "workspaceSidebar.removeRunningWorkspace.title",
        confirmVariant: "destructive",
      }),
    );
    expect(closeTab).not.toHaveBeenCalled();
    expect(releaseWorkspacePreparation).not.toHaveBeenCalled();
  });

  it("运行中 workspace 移除被确认后继续释放 runtime", async () => {
    const closeTab = vi.fn();
    workspaceRuntimeState.draftStatus = "creating";

    renderWorkspaceItem({ closeTab });
    await capturedWorkspaceRemoveSelect?.({
      preventDefault: () => {},
    });
    await Promise.resolve();

    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(closeTab).toHaveBeenCalledWith("workspace-local");
    expect(releaseWorkspacePreparation).toHaveBeenCalledWith({
      workspacePath: "/workspace/project",
    });
  });

  it("workspace 操作菜单 click 必须阻止冒泡到 CollapsibleTrigger", () => {
    const stopPropagation = vi.fn();

    renderWorkspaceItem({ isExpanded: false });
    capturedWorkspaceMenuClick?.({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from "vitest";
import type { AppSettings } from "@zcode/shared";
import {
  buildWorkspacePersistPatch,
  restorePersistedWorkspaceSessions,
} from "@/root/workspaceSessionPersistence.js";
import { createTabStore, isWorkspaceTab } from "@/store/tabStore.js";

const legacyRemoteEntry = {
  kind: "remote",
  workspacePath: "/srv/app",
  workspaceIdentity: "remote:ssh:dev.example.com:22:root:/srv/app",
  target: { kind: "ssh", host: "dev.example.com", username: "root" },
} as unknown as NonNullable<AppSettings["lastWorkspaceSession"]>[number];

function restoredPaths(tabStoreApi: ReturnType<typeof createTabStore>): string[] {
  return tabStoreApi
    .getState()
    .tabs.filter(isWorkspaceTab)
    .map((tab) => tab.workspacePath);
}

describe("restorePersistedWorkspaceSessions", () => {
  it("旧数据里的远程标签页静默丢弃，只恢复本地 workspace 并保持 active 指向本地项", () => {
    const tabStoreApi = createTabStore();

    expect(() =>
      restorePersistedWorkspaceSessions({
        settings: {
          lastWorkspaceSession: [
            { kind: "local", workspacePath: "/workspace/a" },
            legacyRemoteEntry,
            { kind: "local", workspacePath: "/workspace/b" },
          ],
          lastActiveTabIndex: 2,
        },
        tabStoreApi,
      }),
    ).not.toThrow();

    expect(restoredPaths(tabStoreApi)).toEqual(["/workspace/a", "/workspace/b"]);
    expect(tabStoreApi.getState().activeWorkspacePath).toBe("/workspace/b");
    expect(
      tabStoreApi
        .getState()
        .tabs.filter(isWorkspaceTab)
        .some((tab) => tab.remoteTarget || tab.workspaceIdentity || tab.remoteSessionId),
    ).toBe(false);
  });

  it("只有远程标签页时不恢复任何 tab", () => {
    const tabStoreApi = createTabStore();

    restorePersistedWorkspaceSessions({
      settings: { lastWorkspaceSession: [legacyRemoteEntry], lastActiveTabIndex: 0 },
      tabStoreApi,
    });

    expect(restoredPaths(tabStoreApi)).toEqual([]);
  });

  it("active-first 模式先恢复 active workspace，首帧后再补齐完整顺序", () => {
    const tabStoreApi = createTabStore();

    const result = restorePersistedWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/workspace/a" },
          { kind: "local", workspacePath: "/workspace/active" },
          { kind: "local", workspacePath: "/workspace/b" },
        ],
        lastActiveTabIndex: 1,
      },
      restoreMode: "active-first",
      tabStoreApi,
    });

    expect(restoredPaths(tabStoreApi)).toEqual(["/workspace/active"]);
    result?.deferredRestore?.();
    expect(restoredPaths(tabStoreApi)).toEqual(["/workspace/a", "/workspace/active", "/workspace/b"]);
  });
});

describe("buildWorkspacePersistPatch", () => {
  it("只写回本地 workspace，残留远程身份的 tab 不再持久化", () => {
    const tabStoreApi = createTabStore();
    tabStoreApi.getState().restoreTabs(
      [
        "/workspace/a",
        { workspacePath: "/srv/app", workspaceIdentity: "remote:ssh:host:/srv/app" },
        { workspacePath: "/workspace/b", workspacePurpose: "conversation" },
      ],
      2,
    );

    expect(buildWorkspacePersistPatch(tabStoreApi.getState())).toEqual({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: "/workspace/a" },
        { kind: "local", workspacePath: "/workspace/b", workspacePurpose: "conversation" },
      ],
      lastActiveTabIndex: 1,
    });
  });
});

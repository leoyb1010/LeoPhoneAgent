import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readUiSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

// [leo] Web remote control was removed in Leo, so Root no longer mounts the
// WebRemoteControlTaskSync node at all; the remaining contract is that Root keeps the global
// database gate out and never subscribes to the whole workspace table.
describe("Root Web remote task sync subscription boundary", () => {
  it("全局数据库门禁移出 Root，Root 不再挂载远控 task 同步", () => {
    const rootSource = readUiSource("Root.tsx");
    expect(rootSource).not.toContain("useStorageStartup");
    expect(rootSource).not.toContain("WebRemoteControlTaskSync");
    expect(rootSource).not.toContain("webRemoteControlTaskSyncNode");
  });
  it("keeps the Root shell from subscribing to all workspaces", () => {
    const rootSource = readUiSource("Root.tsx");
    const rootInnerSource = rootSource.slice(rootSource.indexOf("function RootInner"));

    // 性能回归保护：Root 不能订阅整张 workspace 表，否则流式更新会唤醒整棵 shell。
    expect(rootInnerSource).not.toContain("useZCodeSessionStore((state) => state.workspaces)");
  });
});

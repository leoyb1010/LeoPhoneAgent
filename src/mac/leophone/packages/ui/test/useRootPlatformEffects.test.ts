import { describe, expect, it } from "vitest";
import { shouldPublishCompleteWorkspaceSnapshot } from "@/root/rootPlatformWorkspaceSync.js";

describe("shouldPublishCompleteWorkspaceSnapshot", () => {
  it("does not publish the renderer-only active-first projection", () => {
    expect(shouldPublishCompleteWorkspaceSnapshot(false)).toBe(false);
    expect(shouldPublishCompleteWorkspaceSnapshot(true)).toBe(true);
  });
});

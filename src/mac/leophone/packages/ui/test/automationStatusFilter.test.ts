import { describe, expect, it } from "vitest";
import {
  AUTOMATION_STATUS_FILTERS,
  filterAutomationsByStatus,
  resolveAutomationStatusFilterKind,
  resolveAutomationTabState,
} from "@/settings/automationStatusFilter.js";

// [leo] Off-peak (idle-time) tasks were removed, so the off-peak status filter cases are gone.

describe("automation status filter", () => {
  it("筛选项固定为 全部/进行中/已完成/失败 四组", () => {
    expect(AUTOMATION_STATUS_FILTERS).toEqual(["all", "inProgress", "completed", "failed"]);
  });

  it("定时任务：卡片显示失败徽章的都归失败，其余按 lifecycle 归组", () => {
    const active = { lifecycleStatus: "active" as const, enabled: true };
    const disabled = { lifecycleStatus: "active" as const, enabled: false };
    const paused = { lifecycleStatus: "paused" as const, enabled: true };
    const completed = { lifecycleStatus: "completed" as const, enabled: true };
    const failedLifecycle = { lifecycleStatus: "failed" as const, enabled: true };
    // 循环任务仍 active，但最近一次运行失败：卡片显示红色失败徽章，应归失败组。
    const activeWithLastError = { ...active, lastError: "boom" };
    const activeDispatchFailed = { ...active, dispatchStatus: "failed_to_dispatch" as const };

    expect(resolveAutomationStatusFilterKind(active)).toBe("inProgress");
    expect(resolveAutomationStatusFilterKind(disabled)).toBe("inProgress");
    expect(resolveAutomationStatusFilterKind(paused)).toBe("inProgress");
    expect(resolveAutomationStatusFilterKind(completed)).toBe("completed");
    expect(resolveAutomationStatusFilterKind(failedLifecycle)).toBe("failed");
    expect(resolveAutomationStatusFilterKind(activeWithLastError)).toBe("failed");
    expect(resolveAutomationStatusFilterKind(activeDispatchFailed)).toBe("failed");

    const all = [active, activeWithLastError, completed, paused];
    expect(filterAutomationsByStatus(all, "all")).toBe(all);
    expect(filterAutomationsByStatus(all, "inProgress")).toEqual([active, paused]);
    expect(filterAutomationsByStatus(all, "failed")).toEqual([activeWithLastError]);
  });

  it("切换顶栏 tab 即重置筛选，切走再切回也不恢复旧筛选（MR !2615 CR-01）", () => {
    const scheduledFailed = { tab: "scheduled" as const, filter: "failed" as const };
    // 同 tab 重复设置：保持原对象，不丢筛选
    expect(resolveAutomationTabState(scheduledFailed, "scheduled")).toBe(scheduledFailed);
    // 切走：回到全部
    const idle = resolveAutomationTabState(scheduledFailed, "idle");
    expect(idle).toEqual({ tab: "idle", filter: "all" });
    // 切回：仍是全部，而不是恢复 failed
    expect(resolveAutomationTabState(idle, "scheduled")).toEqual({
      tab: "scheduled",
      filter: "all",
    });
  });
});

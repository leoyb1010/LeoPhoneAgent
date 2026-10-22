// [leo] 主泳道空闲回收：判定函数 + 扫描计时（假进程表 / 假时钟），不测真实进程拉起。
import { describe, expect, it, vi } from "vitest";
import {
  LEO_MAIN_LANE_IDLE_RECYCLE_MS,
  LEO_RUNNING_AUTOMATION_RUN_MAX_AGE_MS,
  countRunningAutomationRuns,
  createLeoMainLaneIdleRecycler,
  decideLeoMainLaneIdleRecycle,
  type LeoMainLaneRecycleFacts,
} from "#src/zcode-agent/leoMainLaneIdleRecycle.js";

const NOW = 10_000_000_000;

function idleFacts(overrides: Partial<LeoMainLaneRecycleFacts> = {}): LeoMainLaneRecycleFacts {
  return {
    nowMs: NOW,
    lastActivityAtMs: NOW - LEO_MAIN_LANE_IDLE_RECYCLE_MS,
    pendingOperationRequestCount: 0,
    storageStartupWaiting: false,
    startupWaiting: false,
    residentSessionCount: 0,
    residentSampleAtMs: NOW - 30_000,
    conversationSubscriptionCount: 0,
    runningAutomationRunCount: 0,
    pinned: false,
    ...overrides,
  };
}

describe("decideLeoMainLaneIdleRecycle", () => {
  it("回收：20 分钟无活动、无常驻 session、无订阅、无自动化、未钉住", () => {
    expect(decideLeoMainLaneIdleRecycle(idleFacts())).toEqual({ recycle: true });
  });

  it("不足 20 分钟不回收", () => {
    expect(
      decideLeoMainLaneIdleRecycle(
        idleFacts({ lastActivityAtMs: NOW - LEO_MAIN_LANE_IDLE_RECYCLE_MS + 1 }),
      ),
    ).toEqual({ recycle: false, reason: "recently-active" });
  });

  it.each([
    [{ pinned: true }, "pinned"],
    [{ pendingOperationRequestCount: 1 }, "request-in-flight"],
    [{ storageStartupWaiting: true }, "storage-startup"],
    [{ startupWaiting: true }, "startup-waiting"],
    [{ conversationSubscriptionCount: 1 }, "conversation-subscribed"],
    [{ residentSessionCount: 2 }, "resident-sessions"],
    [{ runningAutomationRunCount: 1 }, "automation-running-or-unknown"],
  ] as const)("有保护事实 %o 时不回收（%s）", (overrides, reason) => {
    expect(decideLeoMainLaneIdleRecycle(idleFacts(overrides))).toEqual({
      recycle: false,
      reason,
    });
  });

  it("拿不准就不回收：没收到常驻 session 数、样本过期、自动化台账读失败", () => {
    expect(decideLeoMainLaneIdleRecycle(idleFacts({ residentSessionCount: undefined }))).toEqual({
      recycle: false,
      reason: "resident-sessions-unknown",
    });
    expect(decideLeoMainLaneIdleRecycle(idleFacts({ residentSampleAtMs: undefined }))).toEqual({
      recycle: false,
      reason: "resident-sessions-unknown",
    });
    expect(
      decideLeoMainLaneIdleRecycle(idleFacts({ residentSampleAtMs: NOW - 3 * 60_000 - 1 })),
    ).toEqual({ recycle: false, reason: "resident-sessions-unknown" });
    expect(
      decideLeoMainLaneIdleRecycle(idleFacts({ runningAutomationRunCount: undefined })),
    ).toEqual({ recycle: false, reason: "automation-running-or-unknown" });
  });

  it("钉住优先于其它所有事实（手机默认工作区永不回收）", () => {
    expect(
      decideLeoMainLaneIdleRecycle(
        idleFacts({ pinned: true, residentSessionCount: undefined, lastActivityAtMs: 0 }),
      ),
    ).toEqual({ recycle: false, reason: "pinned" });
  });

  it("可调阈值", () => {
    expect(
      decideLeoMainLaneIdleRecycle(
        idleFacts({ idleThresholdMs: 60_000, lastActivityAtMs: NOW - 60_000 }),
      ),
    ).toEqual({ recycle: true });
  });
});

describe("countRunningAutomationRuns", () => {
  it("只计仍在跑且未超过残留上限的 run", () => {
    expect(
      countRunningAutomationRuns(
        [
          { outcome: "running", updatedAt: NOW - 1_000 },
          { outcome: "succeeded", updatedAt: NOW - 1_000 },
          { updatedAt: NOW - 1_000 },
          // 崩溃残留：标 running 但早已不更新，真在跑的会有常驻 session 兜底。
          { outcome: "running", updatedAt: NOW - LEO_RUNNING_AUTOMATION_RUN_MAX_AGE_MS },
        ],
        NOW,
      ),
    ).toBe(1);
  });
});

describe("createLeoMainLaneIdleRecycler", () => {
  type Listener = (message: { method: string; params?: unknown }) => void;
  function fakeClient() {
    const listeners: Listener[] = [];
    const noop = () => ({ dispose: () => undefined });
    return {
      emit: (method: string, params?: unknown) => {
        for (const listener of listeners) listener({ method, params });
      },
      client: {
        isDisposed: false,
        pendingOperationRequestCount: 0,
        storageStartup: { isWaiting: false },
        onNotification: (listener: Listener) => {
          listeners.push(listener);
          return { dispose: () => undefined };
        },
        onRequest: noop,
        onPendingRequestsDrained: noop,
      },
    };
  }

  it("样本报 0 常驻 session 且 20 分钟无活动才回收；中途有活动则重新计时", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeClient();
      const recycled: string[] = [];
      const managed = { workspacePath: "/tmp/leo-ws", client: fake.client };
      const recycler = createLeoMainLaneIdleRecycler({
        processManager: {
          onRuntimeLifecycle: () => ({ dispose: () => undefined }),
          getExistingClient: () => undefined,
          listManagedProcesses: () => (recycled.length > 0 ? [] : [managed]),
        } as never,
        countConversationSubscriptions: () => 0,
        isStartupWaiting: () => false,
        countRunningAutomationRuns: async () => 0,
        recycle: async (workspace) => {
          recycled.push(workspace.workspacePath);
        },
        log: () => undefined,
      });
      const tickMinutes = async (minutes: number) => {
        for (let minute = 0; minute < minutes; minute += 1) {
          fake.emit("process/resourceSample", { residentSessionCount: 0 });
          await vi.advanceTimersByTimeAsync(60_000);
        }
      };
      await tickMinutes(16); // 首次扫描登记并开始计时
      fake.emit("conversation/frame"); // 有活动：重新计时
      await tickMinutes(19);
      expect(recycled).toEqual([]);
      await tickMinutes(2);
      expect(recycled).toEqual(["/tmp/leo-ws"]);
      recycler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

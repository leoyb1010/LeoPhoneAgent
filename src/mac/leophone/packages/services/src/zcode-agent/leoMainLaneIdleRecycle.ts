// [leo] 主泳道（chat）CLI 进程空闲回收。
//
// 上游只给 mcp-status 控制面泳道做了空闲回收；每个 workspace 的主 CLI 进程一旦拉起就常驻到退出，
// 连带挂在它下面的整棵 MCP 子进程树（Peekaboo / 藏宝阁 / iMCP 等）。这里在 Host 侧每分钟扫一遍，
// 只有「确定没事」才回收；下一次 getClient 由 process manager 透明重新拉起（runtime 换代后
// v4 订阅方按 onAgentRuntimeRestarted 重订，task-index / 侧栏按 existing-only 观察，不会自己拉起）。
//
// 判定刻意保守：任何一项拿不准（没收到 CLI 常驻 session 数、样本过期、读自动化台账失败）都不回收。

import { resolve } from "node:path";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

export const LEO_MAIN_LANE_IDLE_RECYCLE_MS = 20 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/** CLI 每 60s 发一次资源样本；超过 3 个节拍没收到就当作「不知道」。 */
const RESIDENT_SAMPLE_MAX_AGE_MS = 3 * 60_000;
/** 超过这个时长仍标 running 的自动化 run 视为崩溃残留，不再阻止回收（真在跑的会有常驻 session）。 */
export const LEO_RUNNING_AUTOMATION_RUN_MAX_AGE_MS = 6 * 60 * 60_000;

export interface LeoMainLaneRecycleFacts {
  nowMs: number;
  /** 最近一次请求结清 / 收到非诊断类通知 / CLI 反向请求的时间。 */
  lastActivityAtMs: number;
  idleThresholdMs?: number;
  pendingOperationRequestCount: number;
  storageStartupWaiting: boolean;
  /** 有调用方正在等这个 workspace 的模型执行就绪（provider 未就绪时的排队启动）。 */
  startupWaiting: boolean;
  /** CLI 最近一次资源样本里的常驻 session 数；undefined = 没收到或旧 CLI。 */
  residentSessionCount: number | undefined;
  residentSampleAtMs: number | undefined;
  /** renderer / Host 打开的 conversation/* v4 订阅（会话窗格），它们按需拉起 runtime。 */
  conversationSubscriptionCount: number;
  /** 本 workspace 仍在跑的自动化 run；undefined = 读台账失败。 */
  runningAutomationRunCount: number | undefined;
  /** 手机默认工作区等需要常驻的 workspace。 */
  pinned: boolean;
}

export type LeoMainLaneRecycleDecision =
  | { recycle: true }
  | { recycle: false; reason: LeoMainLaneKeepReason };

export type LeoMainLaneKeepReason =
  | "pinned"
  | "request-in-flight"
  | "storage-startup"
  | "startup-waiting"
  | "conversation-subscribed"
  | "resident-sessions-unknown"
  | "resident-sessions"
  | "automation-running-or-unknown"
  | "recently-active";

/** 纯函数：只看一份状态快照决定是否回收。 */
export function decideLeoMainLaneIdleRecycle(
  facts: LeoMainLaneRecycleFacts,
): LeoMainLaneRecycleDecision {
  const keep = (reason: LeoMainLaneKeepReason): LeoMainLaneRecycleDecision => ({
    recycle: false,
    reason,
  });
  if (facts.pinned) return keep("pinned");
  if (facts.pendingOperationRequestCount > 0) return keep("request-in-flight");
  if (facts.storageStartupWaiting) return keep("storage-startup");
  if (facts.startupWaiting) return keep("startup-waiting");
  if (facts.conversationSubscriptionCount > 0) return keep("conversation-subscribed");
  if (
    facts.residentSessionCount === undefined ||
    facts.residentSampleAtMs === undefined ||
    facts.nowMs - facts.residentSampleAtMs > RESIDENT_SAMPLE_MAX_AGE_MS
  ) {
    return keep("resident-sessions-unknown");
  }
  if (facts.residentSessionCount > 0) return keep("resident-sessions");
  if (facts.runningAutomationRunCount === undefined || facts.runningAutomationRunCount > 0) {
    return keep("automation-running-or-unknown");
  }
  const idleThresholdMs = facts.idleThresholdMs ?? LEO_MAIN_LANE_IDLE_RECYCLE_MS;
  if (facts.nowMs - facts.lastActivityAtMs < idleThresholdMs) return keep("recently-active");
  return { recycle: true };
}

/** 诊断类通知按固定节拍发，不代表有人在用这个进程。 */
function isActivityNotification(method: string): boolean {
  return !method.startsWith("process/") && method !== "startup/storageState";
}

// 手机桥接（host/leo/link）注册：它默认把新任务落到的 workspace 必须常驻，避免手机首轮冷启动。
let pinnedWorkspacePathsProvider: (() => readonly string[]) | undefined;

export function setLeoMainLanePinnedWorkspacesProvider(
  provider: (() => readonly string[]) | undefined,
): void {
  pinnedWorkspacePathsProvider = provider;
}

function isPinnedWorkspace(workspacePath: string): boolean {
  let pinned: readonly string[];
  try {
    pinned = pinnedWorkspacePathsProvider?.() ?? [];
  } catch {
    // 读不到就当它被钉住，宁可不回收。
    return true;
  }
  const target = resolve(workspacePath);
  return pinned.some((path) => resolve(path) === target);
}

interface TrackedRuntime {
  client: ZCodeProtocolClient;
  lastActivityAtMs: number;
  residentSessionCount?: number;
  residentSampleAtMs?: number;
  recycling: boolean;
  disposables: IDisposable[];
}

export interface LeoMainLaneIdleRecyclerOptions {
  processManager: {
    onRuntimeLifecycle(
      listener: (event: {
        workspacePath: string;
        workspaceIdentity?: string;
        workspaceKey: string;
        state: "available" | "unavailable";
      }) => void,
    ): IDisposable;
    getExistingClient(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): ZCodeProtocolClient | undefined;
    listManagedProcesses(): Array<{
      workspacePath: string;
      workspaceIdentity?: string;
      client: ZCodeProtocolClient;
    }>;
  };
  countConversationSubscriptions(workspaceKey: string): number;
  isStartupWaiting(workspaceKey: string): boolean;
  countRunningAutomationRuns(workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<number>;
  recycle(workspace: { workspacePath: string; workspaceIdentity?: string }): Promise<void>;
  log(message: string, data: Record<string, unknown>): void;
  now?: () => number;
}

export interface LeoMainLaneIdleRecycler extends IDisposable {
  /**
   * 调用方刚拿到（新拉起或复用）这个 client：记一次活动。拿到 client 到发出第一个请求之间
   * 没有任何在途请求，扫描若恰好在这段空档里判定空闲，会把调用方手里的 client 回收掉。
   */
  noteClientAcquired(client: ZCodeProtocolClient): void;
  /** 本 Host 启动以来回收过的主泳道进程数（日志与内存诊断计数器里都有）。 */
  readonly recycleCount: number;
}

export function createLeoMainLaneIdleRecycler(
  options: LeoMainLaneIdleRecyclerOptions,
): LeoMainLaneIdleRecycler {
  if (process.env.LEO_MAIN_LANE_IDLE_RECYCLE === "0") {
    return { dispose: () => undefined, noteClientAcquired: () => undefined, recycleCount: 0 };
  }
  const now = options.now ?? Date.now;
  const tracked = new Map<string, TrackedRuntime>();
  let recycleCount = 0;
  const diagnostics = registerMemoryDiagnosticsProvider("leoMainLaneIdleRecycle", () => ({
    tracked: tracked.size,
    recycled: recycleCount,
  }));

  const untrack = (workspaceKey: string) => {
    const entry = tracked.get(workspaceKey);
    if (!entry) return;
    for (const disposable of entry.disposables) disposable.dispose();
    tracked.delete(workspaceKey);
  };

  const track = (workspaceKey: string, client: ZCodeProtocolClient) => {
    if (tracked.get(workspaceKey)?.client === client) return;
    untrack(workspaceKey);
    const entry: TrackedRuntime = {
      client,
      lastActivityAtMs: now(),
      recycling: false,
      disposables: [],
    };
    const touch = () => {
      entry.lastActivityAtMs = now();
    };
    entry.disposables.push(
      client.onNotification((message) => {
        if (message.method === "process/resourceSample") {
          const count = (message.params as { residentSessionCount?: unknown } | undefined)
            ?.residentSessionCount;
          if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
            entry.residentSessionCount = count;
            entry.residentSampleAtMs = now();
          }
          return;
        }
        if (isActivityNotification(message.method)) touch();
      }),
      client.onRequest(touch),
      client.onPendingRequestsDrained(touch),
    );
    tracked.set(workspaceKey, entry);
  };

  const lifecycle = options.processManager.onRuntimeLifecycle((event) => {
    // 旁路观测：任何异常都只让这个 workspace 失去回收资格，不能影响生命周期事件的其它监听者。
    try {
      if (event.state === "unavailable") {
        untrack(event.workspaceKey);
        return;
      }
      const client = options.processManager.getExistingClient(event);
      if (client) track(event.workspaceKey, client);
    } catch {
      untrack(event.workspaceKey);
    }
  });

  const sweep = async () => {
    for (const managed of options.processManager.listManagedProcesses()) {
      const workspace = {
        workspacePath: managed.workspacePath,
        ...(managed.workspaceIdentity ? { workspaceIdentity: managed.workspaceIdentity } : {}),
      };
      const workspaceKey = resolveWorkspaceKey(workspace);
      track(workspaceKey, managed.client);
      const entry = tracked.get(workspaceKey);
      if (!entry || entry.recycling || managed.client.isDisposed) continue;
      if (managed.client.pendingOperationRequestCount > 0) entry.lastActivityAtMs = now();
      const facts: LeoMainLaneRecycleFacts = {
        nowMs: now(),
        lastActivityAtMs: entry.lastActivityAtMs,
        pendingOperationRequestCount: managed.client.pendingOperationRequestCount,
        storageStartupWaiting: managed.client.storageStartup.isWaiting,
        startupWaiting: options.isStartupWaiting(workspaceKey),
        residentSessionCount: entry.residentSessionCount,
        residentSampleAtMs: entry.residentSampleAtMs,
        conversationSubscriptionCount: options.countConversationSubscriptions(workspaceKey),
        runningAutomationRunCount: 0,
        pinned: isPinnedWorkspace(workspace.workspacePath),
      };
      // 先用同步事实筛一遍，只有其余条件都满足才去读自动化台账。
      if (!decideLeoMainLaneIdleRecycle(facts).recycle) continue;
      try {
        facts.runningAutomationRunCount = await options.countRunningAutomationRuns(workspace);
      } catch {
        facts.runningAutomationRunCount = undefined;
      }
      // await 期间可能有新活动 / 新请求 / runtime 换代，按最新状态复核。
      if (tracked.get(workspaceKey) !== entry || entry.client !== managed.client) continue;
      facts.nowMs = now();
      facts.lastActivityAtMs = entry.lastActivityAtMs;
      facts.pendingOperationRequestCount = managed.client.pendingOperationRequestCount;
      facts.conversationSubscriptionCount = options.countConversationSubscriptions(workspaceKey);
      facts.startupWaiting = options.isStartupWaiting(workspaceKey);
      if (!decideLeoMainLaneIdleRecycle(facts).recycle) continue;
      entry.recycling = true;
      recycleCount += 1;
      options.log("主泳道 CLI 空闲回收", {
        workspaceKey,
        idleMs: facts.nowMs - facts.lastActivityAtMs,
        recycleCount,
      });
      await options.recycle(workspace).catch((error: unknown) => {
        options.log("主泳道 CLI 空闲回收失败", {
          workspaceKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      untrack(workspaceKey);
    }
  };

  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweep()
      .catch((error: unknown) => {
        options.log("主泳道 CLI 空闲回收扫描失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    dispose: () => {
      clearInterval(timer);
      lifecycle.dispose();
      diagnostics.dispose();
      for (const workspaceKey of [...tracked.keys()]) untrack(workspaceKey);
    },
    noteClientAcquired: (client) => {
      for (const entry of tracked.values()) {
        if (entry.client === client) entry.lastActivityAtMs = now();
      }
    },
    get recycleCount() {
      return recycleCount;
    },
  };
}

export function countRunningAutomationRuns(
  runs: ReadonlyArray<{ outcome?: string; updatedAt: number }>,
  nowMs: number,
): number {
  return runs.filter(
    (run) =>
      run.outcome === "running" && nowMs - run.updatedAt < LEO_RUNNING_AUTOMATION_RUN_MAX_AGE_MS,
  ).length;
}

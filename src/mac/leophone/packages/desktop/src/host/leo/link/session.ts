import path from "node:path";

import type { IZCodeTaskService } from "@zcode/services";
import {
  generateTraceId,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodeStreamEvent,
  type ZCodeTaskMode,
} from "@zcode/shared";

import { describePermission, ZCodeEventMapper } from "./eventMap.js";
import { HarnessJournal, type HarnessEvent, type JournalHealth } from "./journal.js";

/**
 * 发请求的是谁。中继 0.2 转发时附上;0.1 不附,记成 unknown。
 * - iphone:配对过的 iPhone 设备钥匙,全权。
 * - legacy:Android / 鸿蒙的旧版设备钥匙;master:宽限期内的主钥匙。两者审批受限、不能开全自动。
 * - unknown:中继 0.1。它验过钥匙,和切换前经 leoagent 的权限一样;但不能开全自动。
 */
export type CallerKind = "iphone" | "legacy" | "master" | "unknown";
export type Caller = { kind: CallerKind; deviceId?: string; name?: string };

/**
 * 手机协议里的三种答法。"session" 就是「本任务都允许」—— iOS 与手表已有这个选项
 * (显示为"本次会话允许");不用 "always",它在手机上表示永久放行,会误导。
 */
export type ApprovalChoice = "once" | "session" | "deny";
export const APPROVAL_CHOICES: ApprovalChoice[] = ["once", "session", "deny"];

/** 值得推给手机的:要人拍板的审批、要人知道结果的终态。进度帧不推。 */
const PUSHABLE = new Set(["approval.request", "run.completed", "run.failed", "run.cancelled"]);
/** 手机端 reconcile 视为结束的状态;订阅流在这些状态下读完就关。 */
const TERMINAL = new Set(["cancelled", "failed", "completed", "orphaned"]);
/** 旧通道只能批这些只读工具;联网的 WebFetch / WebSearch 不在内。 */
const LEGACY_READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoRead", "TodoWrite"]);
const LEGACY_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const STOP_FALLBACK_MS = 5_000;
const SUBSCRIBER_QUEUE_LIMIT = 512;

type Subscriber = { queue: HarnessEvent[]; wake: (() => void) | null; closed: boolean };
/** announced:审批卡是否已经发给手机;自动放行的没发过,也就不用发回执。 */
type Pending = { request: ZCodePermissionRequest; event: HarnessEvent; tool: string; target: string; announced: boolean };
type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

export type LinkSessionDeps = {
  taskService: IZCodeTaskService;
  journalDir: string;
  /** 已落盘的关键事件交给中继(APNs)。 */
  push: (event: HarnessEvent) => void;
  logger: Logger;
  /** 中继 0.2 起为 true:认不出身份的调用方按旧版设备对待(见 LinkBridge.strictCallers)。 */
  strictCallers?: () => boolean;
};

/**
 * [leo-link] 一个 ZCode 任务在手机协议 v0.4 里的样子:session_id 就是 taskId。
 *
 * 事件先编号、写追加式日志,再扇出给实时订阅者;手机断线后按 seq 续传,一条不丢不重。
 * 审批三种答法:「允许一次」回 allow_once;「本任务都允许」在内存里记下
 * 任务 + 工具 + 目标,之后命中直接回 allow_once(不写 ZCode 的项目级规则);「拒绝」回 deny。
 * 任务处于全自动(yolo)时,上游仍会问的审批由这里直接回 allow_once,不下发手机。
 */
export class LinkSession {
  readonly sessionId: string;
  readonly cwd: string;
  status = "idle";
  mode: ZCodeTaskMode | string = "build";
  seq = 0;
  title = "";
  createdAt = Date.now() / 1000;
  updatedAt = Date.now() / 1000;
  lastEvent: Record<string, unknown> | null = null;
  /** 最近一次发起人;全自动只对 iPhone 发起的任务开放。 */
  lastCaller: Caller | null = null;
  /** Mac 重启后从任务表里认回来的:下一次发消息前先让内核恢复这条会话。 */
  needsResume = false;
  readonly pendingApprovals = new Map<string, Pending>();
  private readonly grants = new Set<string>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly mapper = new ZCodeEventMapper();
  private readonly journal: HarnessJournal;
  private subscription: { dispose(): void } | null = null;
  private stopTimer: NodeJS.Timeout | null = null;

  constructor(
    args: { taskId: string; cwd: string; mode?: ZCodeTaskMode },
    private readonly deps: LinkSessionDeps,
  ) {
    this.sessionId = args.taskId;
    this.cwd = args.cwd;
    if (args.mode) this.mode = args.mode;
    this.journal = new HarnessJournal(path.join(deps.journalDir, `${safeFileName(args.taskId)}.ndjson`), {
      onCommitted: (event) => {
        if (PUSHABLE.has(event.event)) {
          try {
            deps.push(event);
          } catch {
            // 推送失败不影响落盘与续传
          }
        }
      },
      onStateChanged: () => {
        for (const sub of this.subscribers) sub.wake?.();
      },
    });
  }

  get isFullAuto(): boolean {
    return this.mode === "yolo";
  }

  /** 读回日志(重启后接着编号),再订阅这条任务的流。 */
  async open(): Promise<void> {
    await this.journal.initialize();
    this.seq = Math.max(this.seq, this.journal.health().latest_seq);
    this.subscription ??= this.deps.taskService.onDynamicTaskEvent({
      workspacePath: this.cwd,
      taskId: this.sessionId,
      // 与上游机器人同一种订阅:直连的实时流。续传由我们自己的日志负责,不要上游的快照回放。
      deliveryKind: "bot-channel-continuous",
    })((event: ZCodeStreamEvent) => {
      try {
        this.onZCode(event);
      } catch (error) {
        this.deps.logger.warn("[leo/link] event handling failed", { error: String(error) });
      }
    });
  }

  async close(): Promise<void> {
    this.subscription?.dispose();
    this.subscription = null;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    for (const sub of this.subscribers) {
      sub.closed = true;
      sub.wake?.();
    }
    await this.journal.close(1_000);
  }

  // -- 手机发来的动作 -------------------------------------------------------

  async send(text: string, caller: Caller): Promise<void> {
    this.lastCaller = caller;
    this.emit({ event: "user.message", text });
    this.status = "running";
    if (this.needsResume) {
      await this.deps.taskService.resumeTask({ taskId: this.sessionId, workspacePath: this.cwd });
      this.needsResume = false;
    }
    // sendPrompt 在远端 ACK 后就返回,不等这一轮跑完。
    await this.deps.taskService.sendPrompt({
      taskId: this.sessionId,
      traceId: generateTraceId(this.sessionId),
      content: text,
      clientLabel: "leo-link",
    });
  }

  async setMode(mode: ZCodeTaskMode): Promise<void> {
    if (this.mode === mode) return;
    await this.deps.taskService.setMode({ taskId: this.sessionId, mode });
    this.mode = mode;
    if (this.isFullAuto) {
      // 刚切到全自动:已经挂着的审批一并放行,别让它卡在手机上。
      for (const [approvalId, pending] of [...this.pendingApprovals]) {
        void this.answer(approvalId, pending, "allow_once", "once");
      }
    }
  }

  /** 返回 false 表示没送到内核:手机上的卡片要留着。 */
  async respond(approvalId: string, choice: ApprovalChoice, caller: Caller): Promise<"ok" | "missing" | "forbidden" | "undelivered"> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return "missing";
    if (choice !== "deny" && !this.callerMayAllow(caller, pending)) return "forbidden";
    if (choice === "session") this.grants.add(grantKey(pending.tool, pending.target));
    const delivered = await this.answer(approvalId, pending, choice === "deny" ? "deny" : "allow_once", choice);
    return delivered ? "ok" : "undelivered";
  }

  async stop(): Promise<void> {
    const wasRunning = this.status === "running" || this.status === "waiting_for_approval";
    await this.deps.taskService.stopGeneration({ taskId: this.sessionId, workspacePath: this.cwd });
    if (!wasRunning) {
      this.emit({ event: "run.cancelled" });
      return;
    }
    // 正在跑的,等流里的 task_complete(cancelled);内核没回就兜底,别让手机一直转圈。
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (!TERMINAL.has(this.status)) this.emit({ event: "run.cancelled" });
    }, STOP_FALLBACK_MS);
    this.stopTimer.unref();
  }

  // -- ZCode 流 -------------------------------------------------------------

  private onZCode(event: ZCodeStreamEvent): void {
    switch (event.type) {
      case "mode_update":
        this.mode = event.currentModeId;
        return;
      case "task_run_started":
        if (this.status !== "waiting_for_approval") this.status = "running";
        return;
      case "permission_request":
        for (const flushed of this.mapper.flushThought()) this.emit(flushed);
        this.onPermissionRequest(event);
        return;
      case "permission_response":
        // Mac 桌面上答的也要让手机收卡;手机自己答的在 answer() 里已经发过。
        if (this.pendingApprovals.delete(event.requestId)) {
          this.emit({ event: "approval.responded", approval_id: event.requestId, choice: choiceOf(event.optionId) });
        }
        return;
      case "elicitation_request":
        for (const flushed of this.mapper.flushThought()) this.emit(flushed);
        // 手机端还不会答提问和计划审批;挂着会把任务卡死,先自动取消并说一声。
        void this.deps.taskService
          .respondElicitation({ taskId: this.sessionId, workspacePath: this.cwd, requestId: event.requestId, action: "cancel" })
          .catch((error: unknown) => this.deps.logger.warn("[leo/link] elicitation cancel failed", { error: String(error) }));
        this.emit({ event: "session.note", text: `Mac 上的任务问了一个问题,手机端暂时答不了,已跳过:${event.message.slice(0, 120)}` });
        return;
      default:
        for (const mapped of this.mapper.map(event)) this.emit(mapped);
    }
  }

  private onPermissionRequest(request: ZCodePermissionRequest): void {
    if (this.pendingApprovals.has(request.requestId)) return;
    const described = describePermission(request);
    const event: HarnessEvent = {
      event: "approval.request",
      approval_id: request.requestId,
      run_id: request.traceId,
      command: described.command,
      tool: described.tool,
      description: described.description,
      choices: APPROVAL_CHOICES,
    };
    const pending: Pending = { request, event, tool: described.tool, target: described.target, announced: false };
    this.pendingApprovals.set(request.requestId, pending);
    if (this.isFullAuto || this.grants.has(grantKey(described.tool, described.target))) {
      void this.answer(request.requestId, pending, "allow_once", "once");
      return;
    }
    pending.announced = true;
    this.emit(event);
  }

  /** 把答复送进内核。先摘掉待批,流里回来的 permission_response 就不会重复发回执。 */
  private async answer(approvalId: string, pending: Pending, kind: "allow_once" | "deny", choice: ApprovalChoice): Promise<boolean> {
    const option = pickOption(pending.request.options, kind);
    if (!option) return false;
    this.pendingApprovals.delete(approvalId);
    try {
      await this.deps.taskService.respondPermission({
        taskId: this.sessionId,
        workspacePath: this.cwd,
        requestId: approvalId,
        optionId: option.optionId,
        response: option.response,
      });
    } catch (error) {
      this.pendingApprovals.set(approvalId, pending);
      this.deps.logger.warn("[leo/link] approval not delivered", { error: String(error) });
      return false;
    }
    if (pending.announced) this.emit({ event: "approval.responded", approval_id: approvalId, choice });
    return true;
  }

  /** 旧版设备钥匙与主钥匙只能批只读工具和工作区内的改文件;命令、联网、MCP、工作流只能拒绝。 */
  private callerMayAllow(caller: Caller, pending: Pending): boolean {
    if (caller.kind === "iphone") return true;
    if (caller.kind === "unknown" && !(this.deps.strictCallers?.() ?? false)) return true;
    if (LEGACY_READ_ONLY_TOOLS.has(pending.tool)) return true;
    if (LEGACY_EDIT_TOOLS.has(pending.tool)) return isInside(this.cwd, pending.target);
    return false;
  }

  // -- 编号、落盘、扇出 -----------------------------------------------------

  emit(event: HarnessEvent): void {
    this.seq += 1;
    const enriched: HarnessEvent = { ...event, seq: this.seq, session_id: this.sessionId, timestamp: Date.now() / 1000 };
    const name = enriched.event;
    this.updatedAt = Number(enriched.timestamp);
    if (name === "approval.request") this.status = "waiting_for_approval";
    else if (name === "approval.responded") {
      if (this.pendingApprovals.size === 0 && this.status === "waiting_for_approval") this.status = "running";
    } else if (name === "run.completed" || name === "run.failed") {
      this.status = "idle";
      this.pendingApprovals.clear();
    } else if (name === "run.cancelled") {
      this.status = "cancelled";
      this.pendingApprovals.clear();
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (name === "user.message") {
      const text = String(enriched["text"] ?? "").replace(/\s+/g, " ").trim();
      if (!this.title) this.title = text.slice(0, 80);
      this.lastEvent = { event: name, text: text.slice(0, 120), timestamp: enriched["timestamp"] };
    } else if (name === "approval.request" || name === "tool.started" || name.startsWith("run.")) {
      const summary = enriched["command"] ?? enriched["tool"] ?? enriched["error"] ?? "";
      this.lastEvent = { event: name, text: String(summary).slice(0, 120), timestamp: enriched["timestamp"] };
    }

    enriched["durability"] = this.journal.enqueue(enriched, PUSHABLE.has(name));
    for (const sub of [...this.subscribers]) {
      if (sub.queue.length >= SUBSCRIBER_QUEUE_LIMIT) {
        // 卡住的订阅者摘掉,它可以按 seq 从日志追上。
        sub.closed = true;
        this.subscribers.delete(sub);
        sub.wake?.();
        continue;
      }
      sub.queue.push(enriched);
      sub.wake?.();
    }
  }

  journalHealth(): JournalHealth {
    return this.journal.health();
  }

  /** 先登记再回放;回放前先拍下待落盘的事件,免得回放期间提交的漏掉。 */
  async *subscribe(afterSeq = 0, options: { signal?: AbortSignal; journalStatus?: boolean } = {}): AsyncGenerator<HarnessEvent> {
    const sub: Subscriber = { queue: [], wake: null, closed: false };
    this.subscribers.add(sub);
    const pending = this.journal.pendingEvents(afterSeq);
    const abort = () => {
      sub.closed = true;
      sub.wake?.();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let highest = afterSeq;
    let lastHealth = "";
    try {
      for await (const event of this.journal.replay(afterSeq, options.signal)) {
        highest = Math.max(highest, Number(event["seq"] ?? 0));
        yield event;
      }
      for (const event of pending) {
        if (Number(event["seq"]) <= highest) continue;
        highest = Number(event["seq"]);
        yield event;
      }
      while (!sub.closed && !options.signal?.aborted) {
        if (options.journalStatus) {
          const health = this.journal.health();
          const encoded = JSON.stringify(health);
          if (encoded !== lastHealth) {
            lastHealth = encoded;
            // 控制帧没有 seq,不推进手机的游标。
            yield { event: "journal.status", type: "durability", session_id: this.sessionId, ...health };
          }
        }
        if (sub.queue.length) {
          const event = sub.queue.shift()!;
          const seq = Number(event["seq"] ?? 0);
          if (seq <= highest) continue;
          highest = seq;
          yield event;
          continue;
        }
        if (TERMINAL.has(this.status)) {
          if (options.journalStatus && this.journal.health().state === "pending") {
            await this.journal.flush();
            yield { event: "journal.status", type: "durability", session_id: this.sessionId, ...this.journal.health() };
          }
          return;
        }
        await new Promise<void>((resolve) => {
          sub.wake = resolve;
        });
        sub.wake = null;
      }
    } catch (error) {
      if (!options.signal?.aborted) throw error;
    } finally {
      sub.closed = true;
      options.signal?.removeEventListener("abort", abort);
      this.subscribers.delete(sub);
    }
  }

  /** 任务表里的一行:重启后靠它认回手机上已有的任务。 */
  indexEntry(): Record<string, unknown> {
    return { task_id: this.sessionId, cwd: this.cwd, title: this.title, mode: this.mode, created_at: this.createdAt };
  }

  summary(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      harness: "zcode",
      name: "LeoPhoneAgent",
      cwd: this.cwd,
      status: this.status,
      title: this.title,
      full_auto: this.isFullAuto,
      last_event: this.lastEvent,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      seq: this.seq,
      journal: this.journal.health(),
      waiting_for_approval: this.pendingApprovals.size > 0,
      pending_approvals: [...this.pendingApprovals.entries()].map(([id, pending]) => ({
        approval_id: id,
        command: pending.event["command"] ?? "",
        choices: APPROVAL_CHOICES,
      })),
    };
  }
}

function pickOption(options: ZCodePermissionOption[], kind: "allow_once" | "deny"): ZCodePermissionOption | undefined {
  // 按 kind 找,不按显示名;永不落到 allow_always(项目级持久规则)或自定义选项上。
  return options.find((option) => option.kind === kind) ?? options.find((option) => option.optionId === kind);
}

function choiceOf(optionId: string): ApprovalChoice {
  return optionId === "deny" ? "deny" : "once";
}

function grantKey(tool: string, target: string): string {
  return `${tool}\u0000${target}`;
}

function isInside(root: string, target: string): boolean {
  if (!target) return false;
  const resolved = path.resolve(root, target);
  const relative = path.relative(path.resolve(root), resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

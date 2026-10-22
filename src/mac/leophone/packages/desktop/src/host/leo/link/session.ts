/* eslint-disable max-lines -- LinkSession 是单个手机会话的事件/审批/日志状态机,拆开会让 seq 与审批状态出现两份所有者。 */
import path from "node:path";

import type { IZCodeTaskService } from "@zcode/services";
import {
  generateTraceId,
  type ZCodePermissionOption,
  type ZCodePromptAttachment,
  type ZCodePermissionRequest,
  type ZCodeStreamEvent,
  type ZCodeTaskMode,
} from "@zcode/shared";

import { createCheckpoint } from "./changes.js";
import { describePermission, ZCodeEventMapper } from "./eventMap.js";
import { HarnessJournal, type HarnessEvent, type JournalHealth } from "./journal.js";
import { modelFromPicker, sameModel, type SessionModel } from "./remoteModels.js";
import { normalizeQuestions, questionRequestEvent, type PendingQuestion } from "./remoteQuestions.js";

/**
 * 发请求的是谁。中继 0.2 转发时附上;0.1 不附,记成 unknown。
 * - iphone:配对过的设备钥匙;legacy:Android / 鸿蒙的旧版设备钥匙;master:宽限期内的主钥匙。
 *   三者都是用户自己的设备,一样全权(能批准、能开全自动)。原来 legacy / master 只能批只读工具,
 *   用中继钥匙连上的安卓、鸿蒙批不了命令;自用工具不为这个多设一道关(用户 2026-09-26 定的)。
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
// [WP-41] run.started 也推给中继:手机关注的任务一开跑,中继就能 push-to-start 灵动岛(App 被杀也能拉起)。
const PUSHABLE = new Set(["approval.request", "run.started", "run.completed", "run.failed", "run.cancelled"]);
/** 一轮结束的三种事件。 */
const RUN_END = new Set(["run.completed", "run.failed", "run.cancelled"]);
/** 手机端 reconcile 视为结束的状态;订阅流在这些状态下读完就关。 */
const TERMINAL = new Set(["cancelled", "failed", "completed", "orphaned"]);
const STOP_FALLBACK_MS = 5_000;
/** [takeover] 这些事件说明 agent 已连上、开始产出(见 checkResume)。 */
const RESUME_CHECK_EVENTS = new Set(["message.delta", "reasoning.available", "tool.started", "run.completed"]);
/** 跑完一轮后这么久没动静,就不再算「进行中」(见 reportedStatus)。 */
const IDLE_STALE_S = 30 * 60;
const SUBSCRIBER_QUEUE_LIMIT = 512;

type Subscriber = { queue: HarnessEvent[]; wake: (() => void) | null; closed: boolean };
type ElicitationRequest = Extract<ZCodeStreamEvent, { type: "elicitation_request" }>;
/**
 * announced:审批卡是否已经发给手机;自动放行的没发过,也就不用发回执。
 * [leo] kind "plan":计划审批(ExitPlanMode 走的是 elicitation),答复走 respondElicitation,只有批准 / 拒绝。
 */
type Pending =
  | { kind: "permission"; request: ZCodePermissionRequest; event: HarnessEvent; tool: string; target: string; announced: boolean }
  | { kind: "plan"; event: HarnessEvent; tool: string; target: string; announced: true };
type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

/** [leo] 计划审批卡:批准 = 退出计划模式开始执行;没有「本任务都允许」。 */
const PLAN_CHOICES: ApprovalChoice[] = ["once", "deny"];
/** 计划正文放进审批卡的上限(普通审批的命令摘要只给 500 字,计划要长得多)。 */
const PLAN_TEXT_MAX = 4_000;
/** 内核 interaction-broker 认的「批准计划」答案(EXIT_PLAN_MODE_APPROVAL_APPROVE)。 */
const EXIT_PLAN_MODE_APPROVE = "approve";

/** [up-c-mac] 无人值守的自动化运行:没人答的审批自动拒绝时,运行记录里的失败原因。 */
export const UNATTENDED_APPROVAL_REASON = "审批 30 分钟无人处理,已自动拒绝";
/** [leo] 无人值守时计划被拒(手机上拒绝,或 30 分钟没人批)。 */
export const UNATTENDED_PLAN_REASON = "计划未获批准";
/** [leo] 无人值守时 agent 要人回答问题(AskUserQuestion):没人能答,跳过并停掉这次运行。 */
export const UNATTENDED_QUESTION_REASON = "需要人工回答问题，无人值守已跳过";

/**
 * [up-c-mac] 无人值守的自动化运行(docs/specs/leo-link-automations.md「无人值守的审批」):
 * 审批卡(含计划审批)像手机那一轮一样推给手机 / 手表;timeoutMs 内没人答(手机、Mac 都算)就自动拒绝、停掉这一轮,
 * 并用 markFailed 让桥接把这次运行改判为失败。计时只在内存里,答复 / 一轮结束 / 关闭时清掉。
 * markFailed(null) 撤销改判:拒绝没送进内核时运行还会接着跑,之后有人批了就不能记成失败。
 */
type UnattendedRun = {
  automationId: string;
  timeoutMs: number;
  markFailed: (reason: string | null) => void;
  /** [remote-ctl-mac] 这条自动化要不要推送(定时任务的 notify);会话被关注时不看它也推。 */
  notify?: () => boolean;
};
/** [remote-ctl-mac] 会话从哪来:手机建的 / 桌面上的 / 定时任务的 / 接管的终端会话。 */
export type SessionSource = "phone" | "desktop" | "automation" | "takeover";

export type LinkSessionDeps = {
  taskService: IZCodeTaskService;
  journalDir: string;
  /** 已落盘的关键事件交给中继(APNs)。 */
  push: (event: HarnessEvent) => void;
  logger: Logger;
  /** 中继 0.2 起为 true:认不出身份的调用方按旧版设备对待(见 LinkBridge.strictCallers)。 */
  strictCallers?: () => boolean;
  /** 模式变了(含 Mac 桌面上切的):写回任务表,Mac 重启后「关闭全自动」才认得出它。 */
  onModeChanged?: () => void;
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
  /** [E5] 手机侧会话 id(手机建任务 / 发消息时可选带来):随审批与终态推送带回,通知点开直达那个会话。 */
  phoneSessionId: string | null = null;
  /** [takeover] 接管的 Mac 终端 Claude 会话 id:同一个会话再接管时返回这个任务,不再开一个。 */
  externalSessionId: string | null = null;
  /**
   * [takeover] 接管来的会话:回放完历史后由桥接装上,下一次有产出(正文 / 思考 / 工具)时核对一次
   * ACP 是否真的 session/load 上了终端那个会话。load 失败时 CLI 会悄悄新开一个,上下文就丢了。
   */
  resumeCheck: (() => Promise<boolean>) | null = null;
  /** 没能接上终端那个会话(已新开对话);摘要里带 resume_failed。 */
  resumeFailed = false;
  /** Mac 重启后从任务表里认回来的:下一次发消息前先让内核恢复这条会话。 */
  needsResume = false;
  /**
   * [remote-ctl-mac] 关注(省电):只有关注的会话把 approval.request / run.* 交给中继推送。
   * 手机新建 / 接管 / 发消息自动关注;只是打开看看桌面任务不关注。持久化在 sessions.json。
   */
  following = false;
  source: SessionSource = "phone";
  /** [remote-ctl-mac] 当前模型与推理强度;不知道就是 null(外部 agent、还没读到)。 */
  model: SessionModel | null = null;
  /** [remote-ctl-mac] 手机那一轮里等着手机回答的提问(AskUserQuestion),按 requestId。 */
  readonly pendingQuestions = new Map<string, PendingQuestion[]>();
  readonly pendingApprovals = new Map<string, Pending>();
  /** [up-c-mac] 正在无人值守地跑一次自动化;null = 普通任务。 */
  private unattended: UnattendedRun | null = null;
  private readonly approvalTimers = new Map<string, NodeJS.Timeout>();
  /** [leo] 已经答掉(拒绝)的提问:内核会按同一 requestId 重发还没答的提问,桥接补交也可能重复。一轮结束时清空。 */
  private readonly handledQuestions = new Set<string>();
  /** [leo] 进计划模式之前的权限模式:计划获批(内核关掉 planEnabled)后回到它。 */
  private planBaseMode: string | null = null;
  private readonly grants = new Set<string>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly mapper = new ZCodeEventMapper(Date.now, (events) => {
    for (const event of events) this.emit(event);
  });
  private readonly journal: HarnessJournal;
  private subscription: { dispose(): void } | null = null;
  private subscriptionEpoch = 0;
  private subscriptionToken: symbol | null = null;
  private closed = false;
  private stopTimer: NodeJS.Timeout | null = null;
  /** 这一轮是手机发起的。Mac 桌面上自己发起的轮次:提问留给 Mac 上的人答。推送看 following,不看它。 */
  private phoneTurn = false;
  private recordedOperations: Set<string> | null = null;
  /** 发出时就定好要推的事件;落盘回调来得晚,那时 phoneTurn 可能已经清掉。 */
  private readonly pushSeqs = new Set<number>();
  /** 这一轮是否已发过 run.started;一轮结束时复位。 */
  private runAnnounced = false;
  /** 这一轮是否已建过改动检查点;一轮结束时复位。检查点创建在这里串行,轮次编号不撞。 */
  private turnCheckpointed = false;
  private checkpointing: Promise<void> = Promise.resolve();

  constructor(
    args: { taskId: string; cwd: string; mode?: ZCodeTaskMode },
    private readonly deps: LinkSessionDeps,
  ) {
    this.sessionId = args.taskId;
    this.cwd = args.cwd;
    if (args.mode) this.mode = args.mode;
    this.journal = new HarnessJournal(path.join(deps.journalDir, `${safeFileName(args.taskId)}.ndjson`), {
      onCommitted: (event) => {
        if (this.pushSeqs.delete(Number(event["seq"]))) {
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

  /**
   * 读回日志尾部(重启后接着编号),再订阅这条任务的流。完整索引在第一次读写时才建。
   *
   * [up3-link2] deferStream:Mac 重启后认回来的任务先不订阅。它们在内核里多半没恢复(不常驻),
   * 订阅只会撞上 session-unavailable:以前每台 Mac 启动时几十上百条会话各重试 8 次再放弃,
   * 日志被刷满(Studio 133 条)。改成等到真要用时再订阅:send 里 resumeTask 之后、
   * 手机打开这条会话的事件流时、或桥接得知它正在跑(自动化开跑)时,见 attachStream。
   */
  async open(options: { deferStream?: boolean } = {}): Promise<void> {
    const epoch = this.subscriptionEpoch;
    await this.journal.peekTail();
    if (epoch !== this.subscriptionEpoch) return;
    this.seq = Math.max(this.seq, this.journal.health().latest_seq);
    // 最后活动时间以日志里最后一条事件为准(认回来的任务在 restore 里先置成创建时间)。
    this.updatedAt = Math.max(this.updatedAt, this.journal.lastEventAt());
    if (!options.deferStream) this.attachStream();
  }

  /**
   * [up3-link2] 订阅这条任务的实时流;已订阅就不动。fresh = 先退掉旧订阅再订一次:
   * 恢复(resumeTask)之前订的那次可能撞上 session-unavailable 已被放弃(该错误不重试,
   * 见 zcodeAgentService.onDynamicSessionEvent 的 stopOnSessionUnavailable),恢复后必须重订,
   * 否则这轮的事件到不了手机。关闭后不再订。
   */
  attachStream(fresh = false): void {
    if (this.closed) return;
    if (this.subscription && !fresh) return;
    this.subscription?.dispose();
    const epoch = this.subscriptionEpoch;
    const token = Symbol("subscription");
    this.subscriptionToken = token;
    this.subscription = this.deps.taskService.onDynamicTaskEvent({
      workspacePath: this.cwd,
      taskId: this.sessionId,
      // 与上游机器人同一种订阅:直连的实时流。续传由我们自己的日志负责,不要上游的快照回放。
      deliveryKind: "bot-channel-continuous",
    })((event: ZCodeStreamEvent) => {
      // 退订不能撤销已排队的回调；关闭代次先退休，旧mode事件不得在索引drain后重排写入。
      // 重订后旧订阅的回调同样作废,免得同一事件进两次。
      if (epoch !== this.subscriptionEpoch || token !== this.subscriptionToken) return;
      try {
        this.onZCode(event);
      } catch (error) {
        this.deps.logger.warn("[leo/link] event handling failed", { error: String(error) });
      }
    });
  }

  async close(): Promise<void> {
    // 合并窗口里攒着的正文先落盘,再关日志。
    for (const event of this.mapper.flushPending()) this.emit(event);
    this.closed = true;
    this.subscriptionEpoch += 1;
    this.subscription?.dispose();
    this.subscription = null;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.setUnattended(null);
    for (const sub of this.subscribers) {
      sub.closed = true;
      sub.wake?.();
    }
    await this.journal.close(1_000);
  }

  // -- 手机发来的动作 -------------------------------------------------------

  async send(text: string, caller: Caller, operationId?: string, attachments: ZCodePromptAttachment[] = []): Promise<void> {
    // 正在跑时再发是插话(steer),不是新的一轮。
    const newTurn = this.status !== "running" && this.status !== "waiting_for_approval";
    this.lastCaller = caller;
    this.phoneTurn = true;
    this.setFollowing(true);
    // [remote-ctl-mac] 还挂着手机没答的提问时又发了消息(旧版手机只能这样回答):先替它跳过提问,消息照常送进去。
    await this.declinePendingQuestions();
    const attached = attachments.map((item) => ({ name: item.filename, mime: item.mimeType }));
    if (operationId) {
      if (!this.recordedOperations) {
        this.recordedOperations = new Set();
        for await (const event of this.journal.replay()) {
          if (event["event"] === "user.message" && typeof event["operation_id"] === "string") this.recordedOperations.add(event["operation_id"]);
        }
      }
      if (!this.recordedOperations.has(operationId)) {
        this.emit({ event: "user.message", text, operation_id: operationId, ...(attached.length ? { attachments: attached } : {}) });
        const health = await this.journal.flush();
        if (health.durable_seq < this.seq) throw new Error("Input journal is not durable; command not submitted");
        this.recordedOperations.add(operationId);
      }
    } else this.emit({ event: "user.message", text, ...(attached.length ? { attachments: attached } : {}) });
    // 检查点必须在这一轮交给内核之前拍好,否则 agent 的第一笔改动可能已经进了「改动之前」。
    if (newTurn) {
      this.turnCheckpointed = false;
      await this.checkpointTurn(text);
    }
    this.status = "running";
    try {
      await this.ensureResumed();
      // sendPrompt 在远端 ACK 后就返回,不等这一轮跑完。
      await this.deps.taskService.sendPrompt({
        taskId: this.sessionId,
        traceId: operationId ?? generateTraceId(this.sessionId),
        content: text,
        ...(attachments.length ? { attachments } : {}),
        clientLabel: "leo-link",
      });
    } catch (cause) {
      // 没送进内核:写个终态,不然首页和手机上一直显示「运行中」。
      this.emit({ event: "run.failed", error: `发送失败：${cause instanceof Error ? cause.message : String(cause)}` });
      throw cause;
    }
  }

  /** 认回来还没在内核里恢复的会话:先恢复再操作(发消息、换模型、压缩都要会话常驻)。 */
  async ensureResumed(): Promise<void> {
    if (!this.needsResume) return;
    await this.deps.taskService.resumeTask({ taskId: this.sessionId, workspacePath: this.cwd });
    this.needsResume = false;
    // [up3-link2] 认回来的任务推迟到这里订阅:会话已常驻,订阅一次就成;先订再发,这一轮的事件不漏。
    this.attachStream(true);
  }

  /** [remote-ctl-mac] 关注 / 取消关注;变了才发 follow 事件并写回任务表。 */
  setFollowing(following: boolean): void {
    if (this.following === following) return;
    this.following = following;
    this.deps.onModeChanged?.();
    this.emit({ event: "follow", following });
  }

  /** [remote-ctl-mac] 模型或强度变了(手机换的、Mac 上换的、内核报的):记下并告诉手机。 */
  updateModel(model: SessionModel | null): void {
    if (sameModel(this.model, model)) return;
    this.model = model;
    this.deps.onModeChanged?.();
    if (model) this.emit({ event: "model", model });
  }

  /** [remote-ctl-mac] 手机回答提问;content = null 表示跳过(decline)。没这个提问返回 "missing"。 */
  async answerQuestion(questionId: string, content: Record<string, unknown> | null): Promise<"ok" | "missing"> {
    const questions = this.pendingQuestions.get(questionId);
    if (!questions) return "missing";
    // 先摘掉:内核回来的 elicitation_response 不再重复发回执。
    this.pendingQuestions.delete(questionId);
    try {
      await this.deps.taskService.respondElicitation({
        taskId: this.sessionId,
        workspacePath: this.cwd,
        requestId: questionId,
        ...(content ? { action: "accept" as const, content } : { action: "decline" as const }),
      });
    } catch (cause) {
      // 没送进内核,提问还在:手机可以重答。
      this.pendingQuestions.set(questionId, questions);
      throw cause;
    }
    this.emit({ event: "question.responded", question_id: questionId, ...(content ? {} : { declined: true }) });
    return "ok";
  }

  private async declinePendingQuestions(): Promise<void> {
    for (const questionId of Array.from(this.pendingQuestions.keys())) {
      await this.answerQuestion(questionId, null).catch((error: unknown) =>
        this.deps.logger.warn("[leo/link] declining pending question failed", { error: String(error) }),
      );
    }
  }

  async setMode(mode: ZCodeTaskMode): Promise<void> {
    // [leo] 不再因为「本地记的已经是这个模式」就跳过:内核的计划模式是 planEnabled 开关,mode_update 里看不到,
    // 本地记的模式可能是旧的(计划模式下曾被报成 build,手机再切 build 就什么都不发)。切到同一模式内核是幂等的。
    await this.deps.taskService.setMode({ taskId: this.sessionId, mode });
    if (mode === "plan" && this.mode !== "plan") this.planBaseMode = this.mode;
    this.mode = mode;
    this.emit({ event: "mode", type: "mode", mode });
    if (this.isFullAuto) {
      // 刚切到全自动:已经挂着的审批一并放行,别让它卡在手机上(计划审批留给人拍板)。
      for (const [approvalId, pending] of [...this.pendingApprovals]) {
        if (pending.kind === "permission") void this.answer(approvalId, pending, "allow_once", "once");
      }
    }
  }

  /** 返回 false 表示没送到内核:手机上的卡片要留着。 */
  async respond(approvalId: string, choice: ApprovalChoice, caller: Caller): Promise<"ok" | "missing" | "forbidden" | "undelivered"> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return "missing";
    if (choice !== "deny" && !this.callerMayAllow(caller)) return "forbidden";
    // 计划审批没有「本任务都允许」:手机发来 session 也只当这一次批准。
    const answered: ApprovalChoice = pending.kind === "plan" && choice === "session" ? "once" : choice;
    if (answered === "session") this.grants.add(grantKey(pending.tool, pending.target));
    // [leo] 无人值守时手机拒绝了计划:这次运行算失败(内核随后自己结束这一轮)。
    const failReason = pending.kind === "plan" && answered === "deny" && this.unattended ? UNATTENDED_PLAN_REASON : undefined;
    const delivered = await this.answer(approvalId, pending, answered === "deny" ? "deny" : "allow_once", answered, failReason);
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

  /** 每轮一个检查点(非 git 目录什么都不做);失败只记日志,不挡这一轮。 */
  private checkpointTurn(label: string): Promise<void> {
    if (this.turnCheckpointed) return this.checkpointing;
    this.turnCheckpointed = true;
    this.checkpointing = this.checkpointing
      .then(() => createCheckpoint(this.cwd, this.sessionId, label))
      .then(
        () => undefined,
        (cause: unknown) => this.deps.logger.warn("[leo/link] checkpoint failed", { error: String(cause) }),
      );
    return this.checkpointing;
  }

  // -- ZCode 流 -------------------------------------------------------------

  private onZCode(event: ZCodeStreamEvent): void {
    switch (event.type) {
      case "mode_update":
        // [leo] 内核的计划模式是 planEnabled 开关,设置快照里的 mode.current 仍是底下的权限模式(多半是 build),
        // 换模型 / 思考档位的设置更新都会带着它来。计划模式期间收到的「底下那个模式」不代表退出了计划:只记下,
        // 计划获批后回到它。换成别的模式才是真切了(内核切到非 plan 模式会关掉 planEnabled)。
        if (this.mode === "plan" && event.currentModeId !== "plan") {
          if (this.planBaseMode === null || this.planBaseMode === event.currentModeId) {
            this.planBaseMode = event.currentModeId;
            return;
          }
        }
        this.reportMode(event.currentModeId);
        return;
      case "task_run_started":
        if (this.status !== "waiting_for_approval") this.status = "running";
        // 每轮只报一次开跑(内核可能为同一轮重复发 started)。
        if (!this.runAnnounced) {
          this.runAnnounced = true;
          this.emit({ event: "run.started" });
          // Mac 桌面上发起的一轮:只能在开跑时补拍(尽力而为,手机发起的已在 send 里拍好)。
          void this.checkpointTurn("Mac 上发起的一轮");
        }
        return;
      case "permission_request":
        for (const flushed of this.mapper.flushPending()) this.emit(flushed);
        this.onPermissionRequest(event);
        return;
      case "permission_response":
        // Mac 桌面上答的也要让手机收卡;手机自己答的在 answer() 里已经发过。
        if (this.pendingApprovals.delete(event.requestId)) {
          this.clearApprovalTimer(event.requestId);
          this.emit({ event: "approval.responded", approval_id: event.requestId, choice: choiceOf(event.optionId) });
        }
        return;
      case "elicitation_request":
        for (const flushed of this.mapper.flushPending()) this.emit(flushed);
        // Mac 上自己发起的轮次,提问留给 Mac 上的人答;无人值守的自动化没人在 Mac 前,照样要处理。
        if (!this.phoneTurn && !this.unattended) return;
        this.onElicitation(event);
        return;
      case "glm_agent_model_state_update":
        // [remote-ctl-mac] 模型 / 思考档位变了(含 Mac 桌面上换的):手机据此刷新。
        this.updateModel(modelFromPicker(event.model.currentValue, event.thoughtLevel.currentValue) ?? this.model);
        return;
      case "elicitation_response": {
        // [remote-ctl-mac] Mac 上答了手机那边挂着的提问:手机收卡。
        if (this.pendingQuestions.delete(event.requestId)) {
          this.emit({ event: "question.responded", question_id: event.requestId });
          return;
        }
        // [leo] Mac 上答了计划审批:手机收卡(手机自己答的在 answer() 里已经发过回执)。
        const pending = this.pendingApprovals.get(event.requestId);
        if (pending?.kind !== "plan") return;
        this.pendingApprovals.delete(event.requestId);
        this.clearApprovalTimer(event.requestId);
        const approved = event.action === "accept";
        // [leo] 无人值守时有人拒了计划(接管前就推出去的卡):和手机拒绝 / 超时一样记失败。
        if (!approved) this.unattended?.markFailed(UNATTENDED_PLAN_REASON);
        this.emit({ event: "approval.responded", approval_id: event.requestId, choice: approved ? "once" : "deny" });
        if (approved) this.leavePlanMode();
        return;
      }
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
    const pending: Pending = { kind: "permission", request, event, tool: described.tool, target: described.target, announced: false };
    this.pendingApprovals.set(request.requestId, pending);
    if (this.isFullAuto || this.grants.has(grantKey(described.tool, described.target))) {
      void this.answer(request.requestId, pending, "allow_once", "once");
      return;
    }
    pending.announced = true;
    if (this.unattended) {
      event["automation_id"] = this.unattended.automationId;
      this.armApprovalTimer(request.requestId, this.unattended);
    }
    this.emit(event);
  }

  /**
   * [leo] 手机那一轮 / 无人值守运行里内核发来的提问。
   * 计划审批(ExitPlanMode)变成审批卡(无人值守时直接 decline,见 onPlanApproval);其它提问(AskUserQuestion)交给手机作答(question.request),
   * 无人值守时没人能答:拒绝、把这次运行记成失败并停掉,不然它永远挂着(手动运行的占位也一直不放)。
   */
  private onElicitation(request: ElicitationRequest): void {
    const schema = asRecord(request.schema);
    if (schema["interaction"] === "plan_approval") {
      this.onPlanApproval(request, typeof schema["plan"] === "string" ? schema["plan"] : "");
      return;
    }
    if (this.handledQuestions.has(request.requestId)) return;
    this.handledQuestions.add(request.requestId);
    const run = this.unattended;
    if (!run) {
      // [remote-ctl-mac] 手机那一轮:把提问交给手机作答(question.request)。旧版手机认不出这个事件,
      // 同时留一条 kind=question_pending 的提示(新版手机可隐藏);旧版手机直接发消息,send 会先替它跳过提问。
      const questions = normalizeQuestions(request);
      this.pendingQuestions.set(request.requestId, questions);
      this.emit(questionRequestEvent(request.requestId, questions));
      this.emit({ event: "session.note", kind: "question_pending", text: questionNote(request, false) });
      return;
    }
    run.markFailed(UNATTENDED_QUESTION_REASON);
    void this.deps.taskService
      .respondElicitation({ taskId: this.sessionId, workspacePath: this.cwd, requestId: request.requestId, action: "decline" })
      .catch((error: unknown) => this.deps.logger.warn("[leo/link] elicitation decline failed", { error: String(error) }))
      .then(() => this.stop())
      .catch((error: unknown) => this.deps.logger.warn("[leo/link] stopping after skipped question failed", { error: String(error) }));
    this.emit({ event: "session.note", text: questionNote(request, true) });
  }

  /** [leo] 计划审批卡:批准 = 退出计划模式、开始执行;拒绝 = 留在计划模式(内核随后结束这一轮)。 */
  private onPlanApproval(request: ElicitationRequest, plan: string): void {
    if (this.pendingApprovals.has(request.requestId)) return;
    if (this.unattended) {
      // [leo] 无人值守:计划模式每轮都以 ExitPlanMode 收尾(内核提醒强制),早报这类只读运行的产出已经有了。
      // 立刻 decline(内核 plan_exit_denied 结束这一轮,记成功),不推卡、不等 30 分钟、不改判失败。
      if (this.handledQuestions.has(request.requestId)) return;
      this.handledQuestions.add(request.requestId);
      void this.deps.taskService
        .respondElicitation({ taskId: this.sessionId, workspacePath: this.cwd, requestId: request.requestId, action: "decline" })
        .catch((error: unknown) => {
          // 没送进内核就停掉这一轮,不能让运行永远挂着。
          this.deps.logger.warn("[leo/link] unattended plan decline failed", { error: String(error) });
          return this.stop();
        })
        .catch((error: unknown) => this.deps.logger.warn("[leo/link] stopping after plan decline failed", { error: String(error) }));
      return;
    }
    const text = plan.trim();
    const capped = text.length > PLAN_TEXT_MAX ? `${text.slice(0, PLAN_TEXT_MAX - 1)}…` : text;
    const event: HarnessEvent = {
      event: "approval.request",
      approval_id: request.requestId,
      run_id: request.traceId,
      command: "批准计划并开始执行",
      tool: "ExitPlanMode",
      description: capped || "计划正文没有传过来，请到 Mac 上查看",
      ...(capped ? { plan: capped } : {}),
      choices: PLAN_CHOICES,
    };
    // 无人值守的计划审批在上面已直接收下计划并返回,走到这里的只有手机发起的回合。
    this.pendingApprovals.set(request.requestId, { kind: "plan", event, tool: "ExitPlanMode", target: "", announced: true });
    this.emit(event);
  }

  /** [up-c-mac] 桥接接管自动化任务之前就已到的审批 / 提问,接管后补交(审批按 requestId 去重)。 */
  ingest(request: ZCodePermissionRequest | ElicitationRequest): void {
    if (request.type === "permission_request") this.onPermissionRequest(request);
    else if (this.phoneTurn || this.unattended) this.onElicitation(request);
  }

  /** [leo] 计划获批:内核关掉 planEnabled,回到进计划之前的权限模式。 */
  private leavePlanMode(): void {
    if (this.mode === "plan") this.reportMode(this.planBaseMode ?? "build");
  }

  /** 内核报来的模式(含 Mac 桌面上切的)写回任务表并告诉手机;`event` 与 `type` 同值,两种解析都认得。 */
  private reportMode(mode: string): void {
    if (this.mode === mode) return;
    if (mode === "plan") this.planBaseMode = this.mode;
    this.mode = mode;
    this.deps.onModeChanged?.();
    this.emit({ event: "mode", type: "mode", mode });
  }

  /** [up-c-mac] 开始 / 结束一次无人值守的自动化运行;结束时清掉所有自动拒绝计时。 */
  setUnattended(run: UnattendedRun | null): void {
    this.unattended = run;
    if (run) {
      // 接管前就挂着、已经发给手机的审批也要计时。
      for (const [approvalId, pending] of this.pendingApprovals)
        if (pending.announced) this.armApprovalTimer(approvalId, run);
      return;
    }
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
  }

  private armApprovalTimer(approvalId: string, run: UnattendedRun): void {
    if (this.approvalTimers.has(approvalId)) return;
    const timer = setTimeout(() => void this.autoDeny(approvalId), run.timeoutMs);
    timer.unref();
    this.approvalTimers.set(approvalId, timer);
  }

  private clearApprovalTimer(approvalId: string): void {
    const timer = this.approvalTimers.get(approvalId);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(approvalId);
  }

  /** 没人答:拒绝这条审批(同时改判运行失败,内核随后报的终态是 stopped)、停掉这一轮。 */
  private async autoDeny(approvalId: string): Promise<void> {
    this.approvalTimers.delete(approvalId);
    const pending = this.pendingApprovals.get(approvalId);
    const run = this.unattended;
    if (!pending || !run) return;
    const reason = pending.kind === "plan" ? UNATTENDED_PLAN_REASON : UNATTENDED_APPROVAL_REASON;
    // [leo] 拒绝没送进内核时 answer 会撤销改判并重新计时:之后有人批了、运行跑成功,不能被记成审批超时。
    if (!(await this.answer(approvalId, pending, "deny", "deny", reason))) return;
    this.deps.logger.info("[leo/link] unattended approval timed out; denied", {
      taskId: this.sessionId,
      automationId: run.automationId,
    });
    await this.stop().catch((error: unknown) =>
      this.deps.logger.warn("[leo/link] stopping after auto-deny failed", { error: String(error) }),
    );
  }

  /**
   * 把答复送进内核。先摘掉待批,流里回来的 permission_response / elicitation_response 就不会重复发回执。
   * failReason:这次拒绝要把无人值守的运行改判为失败。改判在送出之前记下(拒绝可能让这一轮立刻结束,
   * Host 收终态时改判得已经在),没送到就撤销 —— 只有真送进内核的拒绝才算数。
   */
  private async answer(
    approvalId: string,
    pending: Pending,
    kind: "allow_once" | "deny",
    choice: ApprovalChoice,
    failReason?: string,
  ): Promise<boolean> {
    const deliver = this.delivery(approvalId, pending, kind);
    if (!deliver) return false;
    this.pendingApprovals.delete(approvalId);
    this.clearApprovalTimer(approvalId);
    const run = failReason ? this.unattended : null;
    if (run && failReason) run.markFailed(failReason);
    try {
      await deliver();
    } catch (error) {
      run?.markFailed(null);
      this.pendingApprovals.set(approvalId, pending);
      // 没送到内核,卡片还在:无人值守时重新计时,不能就此永远挂着。
      if (this.unattended && pending.announced) this.armApprovalTimer(approvalId, this.unattended);
      this.deps.logger.warn("[leo/link] approval not delivered", { error: String(error) });
      return false;
    }
    if (pending.announced) this.emit({ event: "approval.responded", approval_id: approvalId, choice });
    if (pending.kind === "plan" && kind === "allow_once") this.leavePlanMode();
    return true;
  }

  /** 普通审批回所选选项;计划审批回 elicitation(批准 = accept + approve,拒绝 = decline)。 */
  private delivery(approvalId: string, pending: Pending, kind: "allow_once" | "deny"): (() => Promise<unknown>) | null {
    const target = { taskId: this.sessionId, workspacePath: this.cwd, requestId: approvalId };
    if (pending.kind === "plan") {
      return () =>
        this.deps.taskService.respondElicitation(
          kind === "deny"
            ? { ...target, action: "decline" }
            : { ...target, action: "accept", content: { answer: EXIT_PLAN_MODE_APPROVE } },
        );
    }
    const option = pickOption(pending.request.options, kind);
    if (!option) return null;
    return () => this.deps.taskService.respondPermission({ ...target, optionId: option.optionId, response: option.response });
  }

  /** 认得出是哪台设备就能批;只有中继 0.2 下认不出身份的请求只能拒绝。 */
  private callerMayAllow(caller: Caller): boolean {
    return caller.kind !== "unknown" || !(this.deps.strictCallers?.() ?? false);
  }

  // -- 编号、落盘、扇出 -----------------------------------------------------

  emit(event: HarnessEvent): void {
    // 正文增量在 mapper 里按 50ms 合并;会话自己发的事件(用户消息、终态兜底、提示、模式)之前先把它发出去,顺序不乱。
    if (event.event !== "message.delta" && event.event !== "reasoning.available") {
      for (const flushed of this.mapper.flushPending()) this.emit(flushed);
    }
    if (RUN_END.has(event.event) && this.pendingQuestions.size) {
      // [remote-ctl-mac] 这一轮结束,没答的提问也作废:手机收卡。
      const stale = [...this.pendingQuestions.keys()];
      this.pendingQuestions.clear();
      for (const questionId of stale) this.emit({ event: "question.responded", question_id: questionId, expired: true });
    }
    if (RUN_END.has(event.event) && this.pendingApprovals.size) {
      // 这一轮结束了,还挂着的审批随之作废:发回执让手机收卡,不然重放日志时卡片又冒出来。
      const stale = [...this.pendingApprovals];
      this.pendingApprovals.clear();
      for (const [approvalId] of stale) this.clearApprovalTimer(approvalId);
      for (const [approvalId, pending] of stale) {
        if (pending.announced) this.emit({ event: "approval.responded", approval_id: approvalId, choice: "deny" });
      }
    }
    this.seq += 1;
    const enriched: HarnessEvent = { ...event, seq: this.seq, session_id: this.sessionId, timestamp: Date.now() / 1000 };
    const name = enriched.event;
    this.updatedAt = Number(enriched.timestamp);
    if (name === "approval.request") this.status = "waiting_for_approval";
    else if (name === "approval.responded") {
      if (this.pendingApprovals.size === 0 && this.status === "waiting_for_approval") this.status = "running";
    }
    if (RUN_END.has(name)) {
      this.status = name === "run.cancelled" ? "cancelled" : "idle";
      // 停止和正常结束撞上时,兜底计时器别再补一个 run.cancelled。
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (PUSHABLE.has(name) && this.phoneSessionId) enriched["phone_session_id"] = this.phoneSessionId;
    // [remote-ctl-mac] 推送只给关注的会话(以前看「这一轮是不是手机发起的」)。不关注的照常记日志、手机打开照常看到。
    if (PUSHABLE.has(name) && this.following) this.pushSeqs.add(this.seq);
    // [up-c-mac] 无人值守的自动化:审批卡照样推(终态由 automation.run.completed 单独推,这里不重复)。
    // [remote-ctl-mac] 只在这条自动化 notify 打开(或会话被关注)时推;30 分钟自动拒绝不受影响。
    else if (name === "approval.request" && this.unattendedPushes()) this.pushSeqs.add(this.seq);
    // [up3-link2] 无人值守时审批答完(手机 / Mac 答的、超时自动拒绝的)也推:中继据此把审批拉起的灵动岛
    // 改回「运行中」。中继对 approval.responded 不发 APNs 提醒、灵动岛更新不带 alert,不会再响一次。
    else if (name === "approval.responded" && this.unattendedPushes()) this.pushSeqs.add(this.seq);
    if (RUN_END.has(name)) {
      // 这一轮(含无人值守的自动化运行)结束:自动拒绝计时一并作废。
      if (this.unattended) this.setUnattended(null);
      this.handledQuestions.clear();
      this.phoneTurn = false;
      this.runAnnounced = false;
      this.turnCheckpointed = false;
    }
    if (this.resumeCheck && RESUME_CHECK_EVENTS.has(name)) this.checkResume(this.resumeCheck);
    if (name === "user.message") {
      const text = String(enriched["text"] ?? "").replace(/\s+/g, " ").trim();
      if (!this.title) this.title = text.slice(0, 80);
      this.lastEvent = { event: name, text: text.slice(0, 120), timestamp: enriched["timestamp"] };
    } else if (name === "approval.request" || name === "tool.started" || name.startsWith("run.")) {
      const summary = enriched["command"] ?? enriched["tool"] ?? enriched["error"] ?? "";
      this.lastEvent = { event: name, text: String(summary).slice(0, 120), timestamp: enriched["timestamp"] };
    }

    enriched["durability"] = this.journal.enqueue(enriched, PUSHABLE.has(name) || this.pushSeqs.has(this.seq));
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

  private unattendedPushes(): boolean {
    return Boolean(this.unattended) && (this.following || (this.unattended?.notify?.() ?? false));
  }

  /** 有产出说明 agent 已连上,这时 CLI 已写好映射:对不上就是 load 失败。只核对一次;读不到映射不报。 */
  private checkResume(check: () => Promise<boolean>): void {
    this.resumeCheck = null;
    void check().then(
      (held) => {
        if (held) return;
        this.resumeFailed = true;
        this.deps.onModeChanged?.(); // 写回任务表(重启后摘要照样带 resume_failed)
        this.emit({
          event: "session.note",
          kind: "resume_failed",
          // [codex-sessions] Codex 会话同样走这里:名字取任务实际的 agent。
          text: `没能接上终端里的那个会话，已新开一个对话：${this.harnessName} 看不到之前的上下文。Mac 上的 ${this.harnessName} 版本可能太旧，或 Mac 上还开着这个会话；更新或关掉后可重新接管。`,
        });
      },
      (cause: unknown) => this.deps.logger.warn("[leo/link] resume check failed", { error: String(cause) }),
    );
  }

  journalHealth(): JournalHealth {
    return this.journal.health();
  }

  /** 先登记再回放;回放前先拍下待落盘的事件,免得回放期间提交的漏掉。 */
  async *subscribe(afterSeq = 0, options: { signal?: AbortSignal; journalStatus?: boolean } = {}): AsyncGenerator<HarnessEvent> {
    // [up3-link2] 手机打开认回来的旧会话:接上实时流。会话若正在 Mac 上跑(常驻),实时事件照常到手机;
    // 没常驻则只试一次(session-unavailable 不重试),之后手机一发消息 send 会在恢复后重订。
    this.attachStream();
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
  /** [WP-21] 手机端 harness key 与显示名：LeoBot 自己是 zcode，ACP 外部 agent 是 claude / codex / …。 */
  harness = "zcode";
  harnessName = "LeoBot";

  indexEntry(): Record<string, unknown> {
    return { task_id: this.sessionId, cwd: this.cwd, title: this.title, mode: this.mode, created_at: this.createdAt, phone_session_id: this.phoneSessionId ?? undefined, harness: this.harness, harness_name: this.harnessName, external_session_id: this.externalSessionId ?? undefined, resume_failed: this.resumeFailed || undefined, following: this.following, source: this.source, model: this.model ?? undefined };
  }

  /**
   * 跑完一轮、半小时没再动的任务报 "available"(和没在跑的桌面任务一样)。
   * 手机首页「进行中」和 Siri 把 idle 当成还在进行:以前跑完的任务永远占着那一节,清不掉
   * (用户 2026-09-26 报的四条)。手机点开照样能接着聊 —— 它把 available 当 idle 接。
   */
  private reportedStatus(): string {
    if (this.status === "idle" && Date.now() / 1000 - this.updatedAt > IDLE_STALE_S) return "available";
    return this.status;
  }

  summary(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      harness: this.harness,
      name: this.harnessName,
      cwd: this.cwd,
      status: this.reportedStatus(),
      title: this.title,
      mode: this.mode,
      full_auto: this.isFullAuto,
      last_event: this.lastEvent,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      seq: this.seq,
      journal: this.journal.health(),
      ...(this.resumeFailed ? { resume_failed: true } : {}),
      following: this.following,
      source: this.source,
      model: this.model,
      waiting_for_approval: this.pendingApprovals.size > 0,
      pending_approvals: [...this.pendingApprovals.entries()].map(([id, pending]) => ({
        approval_id: id,
        command: pending.event["command"] ?? "",
        choices: pending.event["choices"] ?? APPROVAL_CHOICES,
      })),
    };
  }
}

function pickOption(options: ZCodePermissionOption[], kind: "allow_once" | "deny"): ZCodePermissionOption | undefined {
  // 按 kind 找,不按显示名;永不落到 allow_always(项目级持久规则)或自定义选项上。
  return options.find((option) => option.kind === kind) ?? options.find((option) => option.optionId === kind);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** [leo] 手机还答不了的提问:把问题和选项原文带给手机,用户可以直接发消息回答。 */
function questionNote(request: ElicitationRequest, unattended: boolean): string {
  const questions = request.questions?.length ? request.questions : [{ question: request.message, options: request.options }];
  const asked = questions
    .slice(0, 3)
    .map(({ question, options }) => {
      const labels = options
        .map((option) => option.label)
        .filter(Boolean)
        .slice(0, 6);
      return labels.length ? `${question}（${labels.join(" / ")}）` : question;
    })
    .join("；");
  const head = unattended
    ? "无人值守的定时任务要人回答问题，没人在场，已跳过并停掉这次运行"
    : "Mac 上的任务在等你回答问题；旧版手机答不了，直接发消息告诉它即可（会先跳过这个问题）";
  const text = `${head}：${asked}`;
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

function choiceOf(optionId: string): ApprovalChoice {
  return optionId === "deny" ? "deny" : "once";
}

function grantKey(tool: string, target: string): string {
  return `${tool}\u0000${target}`;
}

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

// [leo][WP-21] 一个 LeoBot 会话 ↔ 一个 ACP agent 会话。
// 把 ACP 的 session/update 与 request_permission 变成按序消费的事件队列：
//   text / thought      → 模型流的正文 / 思考增量
//   tool                → 一次 AcpToolCall（由 LeoBot 运行时执行：权限档、审批卡、工具卡都复用）
//   plan                → 计划条目（翻成 TodoWrite）
//   stop / error        → 本轮结束
// 权限：agent 发起 request_permission 时，这一步以 needsApproval=true 交给运行时；运行时的
// 审批结果经 AcpToolCall 的 handler（批准）或下一次模型请求（拒绝）回到这里。
import type {
  Agent,
  Client,
  ContentBlock,
  PlanEntry,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { AcpAgentCommand, AcpAgentId, AcpToolCallInput, AcpToolCallOutput } from "@zcode/shared/acp";
import { contentText, isTerminal, pickOption, summarizeTool, toToolInput, type ToolState } from "./tool-state.js";

export { ACP_DIFF_LIMIT_BYTES, capDiff, contentText } from "./tool-state.js";

export type AcpHostEvent =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; input: AcpToolCallInput }
  | { kind: "plan"; entries: PlanEntry[] }
  | {
      kind: "stop";
      stopReason: StopReason;
      usage?: { inputTokens?: number; outputTokens?: number };
      /** [fix-remote] 这一轮 agent 什么都没说、没调工具、没给计划。 */
      empty?: boolean;
    }
  | { kind: "error"; error: unknown };



export interface AcpConnectionLike {
  agent: Pick<Agent, "prompt" | "cancel">;
  sessionId: string;
}

export class AcpSessionHost {
  readonly agentId: AcpAgentId;
  readonly #tools = new Map<string, ToolState>();
  readonly #queue: AcpHostEvent[] = [];
  #waiter: ((event: AcpHostEvent) => void) | undefined;
  #connection: AcpConnectionLike | undefined;
  #turnActive = false;
  /**
   * 轮次序号：每次 startTurn 加一。prompt 的回调只认自己那一轮——
   * 取消后旧一轮的 stop / 错误常常晚于下一轮的 startTurn 才到，不按序号丢掉就会把新一轮当场结束。
   */
  #turnSeq = 0;
  /** 最近一次活动（开轮、agent 更新、授权请求）的时间；管理器据此回收闲置进程。 */
  #lastActivityAt = Date.now();
  /** 本轮 agent 有没有产出（正文 / 思考 / 工具 / 计划）。 */
  #turnOutput = false;
  #announceSeq = 0;
  #availableCommands: AcpAgentCommand[] = [];
  readonly #onCommands: ((commands: AcpAgentCommand[]) => void) | undefined;

  constructor(agentId: AcpAgentId, options: { onCommands?: (commands: AcpAgentCommand[]) => void } = {}) {
    this.agentId = agentId;
    this.#onCommands = options.onCommands;
  }

  attach(connection: AcpConnectionLike): void {
    this.#connection = connection;
  }

  get turnActive(): boolean {
    return this.#turnActive;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  /** 还有 agent 等着答复的授权（闲置回收时不能把它掐掉）。 */
  get hasPendingPermission(): boolean {
    for (const tool of this.#tools.values()) if (tool.permission) return true;
    return false;
  }

  get availableCommands(): readonly AcpAgentCommand[] {
    return this.#availableCommands;
  }

  /** ACP Client 的两个必需回调（其余能力不声明：文件与命令由 agent 自己执行）。 */
  clientHandlers(): Pick<Client, "sessionUpdate" | "requestPermission" | "extNotification"> {
    return {
      sessionUpdate: (params) => this.#onSessionUpdate(params),
      requestPermission: (params) => this.#onRequestPermission(params),
      // [fix-remote] grok 等会发私有通知（x.ai/…）：静默忽略，不当成协议错误。
      extNotification: async () => undefined,
    };
  }

  /** [fix-remote] agent 进程在回合中途没了：以错误结束这一轮（否则运行时一直等下一条事件）。 */
  failTurn(error: unknown): void {
    if (!this.#turnActive) return;
    this.#endTurn();
    this.#push({ kind: "error", error });
  }

  startTurn(prompt: ContentBlock[]): void {
    const connection = this.#requireConnection();
    const turn = ++this.#turnSeq;
    // [fix] 停止后错位：上一轮遗留在队列里的事件（典型是取消后的 stop）不属于这一轮，清掉；
    // 上一轮的工具也一并清掉（仍挂着的授权按取消回复），工具表不跨轮增长。
    this.#queue.length = 0;
    this.#dropTools();
    this.#turnActive = true;
    this.#turnOutput = false;
    this.#lastActivityAt = Date.now();
    void Promise.resolve(connection.agent.prompt({ sessionId: connection.sessionId, prompt }))
      .then(
        (response) => {
          if (turn !== this.#turnSeq) return;
          this.#endTurn();
          this.#flushPendingAnnouncements();
          this.#push({
            kind: "stop",
            stopReason: response.stopReason,
            ...(this.#turnOutput ? {} : { empty: true }),
            ...(response.usage
              ? {
                  usage: {
                    inputTokens: response.usage.inputTokens ?? undefined,
                    outputTokens: response.usage.outputTokens ?? undefined,
                  },
                }
              : {}),
          });
        },
        (error: unknown) => {
          if (turn === this.#turnSeq) this.failTurn(error);
        },
      );
  }

  /** 只由当前轮的结束调用：清 turnActive，并叫醒还在等终态的工具（本轮结束即视为结束）。 */
  #endTurn(): void {
    this.#turnActive = false;
    for (const tool of this.#tools.values()) this.#wake(tool);
  }

  #dropTools(): void {
    for (const tool of this.#tools.values()) {
      tool.permission?.resolve({ outcome: { outcome: "cancelled" } });
      tool.permission = undefined;
      this.#wake(tool);
    }
    this.#tools.clear();
  }

  async cancel(): Promise<void> {
    const connection = this.#connection;
    // 进行中的授权一律按取消回复（协议要求），再发 session/cancel。
    for (const tool of this.#tools.values()) {
      if (tool.permission) {
        tool.permission.resolve({ outcome: { outcome: "cancelled" } });
        tool.permission = undefined;
      }
    }
    if (connection && this.#turnActive) {
      await Promise.resolve(connection.agent.cancel({ sessionId: connection.sessionId })).catch(
        () => undefined,
      );
    }
  }

  /** 取下一条事件；signal 中止时抛 AbortError。 */
  next(signal?: AbortSignal): Promise<AcpHostEvent> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#waiter = undefined;
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiter = (event) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(event);
      };
    });
  }

  /** 非阻塞地取一条已排队的工具事件（把同一时刻的多个工具调用合进一步）。 */
  takeQueuedTool(): Extract<AcpHostEvent, { kind: "tool" }> | undefined {
    const head = this.#queue[0];
    if (head?.kind !== "tool") return undefined;
    this.#queue.shift();
    return head;
  }

  /** 运行时批准了这一步（或无需授权）：回复 agent 的授权请求并等这步跑完。 */
  async runApprovedTool(
    leoToolCallId: string,
    acpToolCallId: string,
    options: { allowAlways?: boolean; signal?: AbortSignal } = {},
  ): Promise<AcpToolCallOutput> {
    const tool = this.#tools.get(acpToolCallId);
    if (!tool) {
      return { status: "failed", title: acpToolCallId, kind: "other", text: "这一步已不在当前会话中" };
    }
    if (tool.permission && (tool.permission.announcedAs ?? leoToolCallId) === leoToolCallId) {
      const option =
        pickOption(tool.permission.options, options.allowAlways ? "allow_always" : "allow_once") ??
        pickOption(tool.permission.options, "allow_once") ??
        pickOption(tool.permission.options, "allow_always");
      tool.permission.resolve(
        option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } },
      );
      tool.permission = undefined;
    }
    await this.#waitForTerminal(tool, options.signal);
    return summarizeTool(tool);
  }

  /** 运行时拒绝 / 跳过了这些调用：仍挂着的授权一律拒绝。 */
  rejectPending(leoToolCallIds: readonly string[]): void {
    const ids = new Set(leoToolCallIds);
    for (const tool of this.#tools.values()) {
      const announcedAs = tool.permission?.announcedAs;
      if (tool.permission && announcedAs && ids.has(announcedAs)) {
        const option =
          pickOption(tool.permission.options, "reject_once") ??
          pickOption(tool.permission.options, "reject_always");
        tool.permission.resolve(
          option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } },
        );
        tool.permission = undefined;
      }
    }
  }

  /** 已交给运行时、但授权还没回复的 LeoBot 工具调用 id。 */
  pendingApprovalIds(): string[] {
    const ids: string[] = [];
    for (const tool of this.#tools.values()) {
      if (tool.permission?.announcedAs) ids.push(tool.permission.announcedAs);
    }
    return ids;
  }

  #requireConnection(): AcpConnectionLike {
    if (!this.#connection) throw new Error("ACP agent 尚未连接");
    return this.#connection;
  }

  #push(event: AcpHostEvent): void {
    if (event.kind === "text" || event.kind === "thought" || event.kind === "tool" || event.kind === "plan") {
      this.#turnOutput = true;
    }
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter(event);
      return;
    }
    this.#queue.push(event);
  }

  #onSessionUpdate(params: SessionNotification): void {
    this.#lastActivityAt = Date.now();
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (text) this.#push({ kind: "text", text });
        return;
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        if (text) this.#push({ kind: "thought", text });
        return;
      }
      case "tool_call": {
        const tool = this.#ensureTool(update.toolCallId);
        tool.title = update.title || tool.title;
        tool.kind = update.kind ?? tool.kind;
        tool.status = update.status ?? tool.status;
        if (update.content) tool.content = update.content;
        if (update.locations) tool.locations = update.locations;
        if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
        this.#scheduleAnnouncement(tool);
        return;
      }
      case "tool_call_update": {
        const tool = this.#ensureTool(update.toolCallId);
        if (update.title) tool.title = update.title;
        if (update.kind) tool.kind = update.kind;
        if (update.status) tool.status = update.status;
        if (update.content) tool.content = update.content;
        if (update.locations) tool.locations = update.locations;
        if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
        if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput;
        if (!tool.announced && tool.status !== "pending") this.#announce(tool, false);
        if (isTerminal(tool.status)) this.#wake(tool);
        return;
      }
      case "plan":
        this.#push({ kind: "plan", entries: update.entries });
        return;
      case "available_commands_update":
        // [leo] agent 自带的斜杠命令：交给管理器落盘，界面输入 / 时列出（见 shared/acp.ts）。
        this.#availableCommands = update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.input && "hint" in command.input && command.input.hint
            ? { inputHint: `/${command.name} ${command.input.hint}` }
            : {}),
        }));
        this.#onCommands?.(this.#availableCommands);
        return;
      default:
        return;
    }
  }

  #onRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const update = params.toolCall;
    this.#lastActivityAt = Date.now();
    const tool = this.#ensureTool(update.toolCallId);
    if (update.title) tool.title = update.title;
    if (update.kind) tool.kind = update.kind;
    if (update.content) tool.content = update.content;
    if (update.locations) tool.locations = update.locations;
    if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
    return new Promise((resolve) => {
      tool.permission = { options: params.options, resolve };
      // 已经以「无需授权」交给过运行时（agent 晚于宽限期才问）：再交一次、这次带审批。
      this.#announce(tool, true, tool.announced);
    });
  }

  #ensureTool(id: string): ToolState {
    let tool = this.#tools.get(id);
    if (!tool) {
      tool = {
        id,
        title: id,
        kind: "other",
        status: "pending",
        content: [],
        locations: [],
        rawInput: undefined,
        rawOutput: undefined,
        announced: false,
        waiters: [],
      };
      this.#tools.set(id, tool);
    }
    return tool;
  }

  /**
   * 只在两种时刻把这一步交给运行时：agent 来要授权（needsApproval），或状态离开 pending（已在执行，无需授权）。
   * Claude Code 会先发一条内容为空的 pending 调用，约一秒后才补上 diff 并请求授权——按时间猜会交早、出重复卡。
   */
  #scheduleAnnouncement(tool: ToolState): void {
    if (!tool.announced && tool.status !== "pending") this.#announce(tool, false);
  }

  /** 本轮结束时还没交出去的调用（agent 没发终态）也补一张卡，免得结果被吞掉。 */
  #flushPendingAnnouncements(): void {
    for (const tool of this.#tools.values()) {
      if (!tool.announced) this.#announce(tool, false);
    }
  }

  #announce(tool: ToolState, needsApproval: boolean, reannounce = false): void {
    if (tool.announced && !reannounce) return;
    tool.announced = true;
    const leoToolCallId = reannounce
      ? `acp-${tool.id}-${++this.#announceSeq}`
      : `acp-${tool.id}`;
    if (needsApproval && tool.permission) tool.permission.announcedAs = leoToolCallId;
    this.#push({ kind: "tool", input: toToolInput(this.agentId, tool, needsApproval, leoToolCallId) });
  }

  #wake(tool: ToolState): void {
    const waiters = tool.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  /**
   * 等这步收尾。本轮结束而这步一直没收尾（agent 省略了最后一次 update）时由 #endTurn 叫醒。
   * [fix] 以前靠 250ms 轮询判断轮结束，abort 时轮询不清、一直跑；改成事件叫醒，abort 时摘掉等待者。
   */
  #waitForTerminal(tool: ToolState, signal?: AbortSignal): Promise<void> {
    if (isTerminal(tool.status) || !this.#turnActive) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = tool.waiters.indexOf(waiter);
        if (index >= 0) tool.waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      tool.waiters.push(waiter);
    });
  }
}

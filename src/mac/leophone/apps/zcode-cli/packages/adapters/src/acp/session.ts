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
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import type { AcpAgentCommand, AcpAgentId, AcpToolCallInput, AcpToolCallOutput } from "@zcode/shared/acp";

export type AcpHostEvent =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; input: AcpToolCallInput }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "stop"; stopReason: StopReason; usage?: { inputTokens?: number; outputTokens?: number } }
  | { kind: "error"; error: unknown };

interface ToolState {
  id: string;
  title: string;
  kind: string;
  status: string;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput: unknown;
  rawOutput: unknown;
  announced: boolean;
  permission?: {
    options: PermissionOption[];
    resolve: (response: RequestPermissionResponse) => void;
    /** 以哪个 LeoBot 工具调用 id 交给了运行时（同一 ACP 调用在竞态下可能再交一次）。 */
    announcedAs?: string;
  };
  waiters: Array<() => void>;
}

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

  get availableCommands(): readonly AcpAgentCommand[] {
    return this.#availableCommands;
  }

  /** ACP Client 的两个必需回调（其余能力不声明：文件与命令由 agent 自己执行）。 */
  clientHandlers(): Pick<Client, "sessionUpdate" | "requestPermission"> {
    return {
      sessionUpdate: (params) => this.#onSessionUpdate(params),
      requestPermission: (params) => this.#onRequestPermission(params),
    };
  }

  startTurn(prompt: ContentBlock[]): void {
    const connection = this.#requireConnection();
    this.#turnActive = true;
    void Promise.resolve(connection.agent.prompt({ sessionId: connection.sessionId, prompt }))
      .then(
        (response) => {
          this.#turnActive = false;
          this.#flushPendingAnnouncements();
          this.#push({
            kind: "stop",
            stopReason: response.stopReason,
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
          this.#turnActive = false;
          this.#push({ kind: "error", error });
        },
      );
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
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter(event);
      return;
    }
    this.#queue.push(event);
  }

  #onSessionUpdate(params: SessionNotification): void {
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

  #waitForTerminal(tool: ToolState, signal?: AbortSignal): Promise<void> {
    if (isTerminal(tool.status) || !this.#turnActive) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      tool.waiters.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      // 本轮结束而这步一直没收尾（agent 省略了最后一次 update）：轮结束即视为结束。
      const poll = setInterval(() => {
        if (!this.#turnActive) {
          clearInterval(poll);
          this.#wake(tool);
        }
      }, 250);
      tool.waiters.push(() => clearInterval(poll));
    });
  }
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}

function pickOption(
  options: readonly PermissionOption[],
  kind: PermissionOption["kind"],
): PermissionOption | undefined {
  return options.find((option) => option.kind === kind);
}

export function contentText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.uri;
    case "resource":
      return "text" in content.resource ? content.resource.text : "";
    default:
      return "";
  }
}

function firstLocationPath(tool: ToolState): string | undefined {
  return tool.locations[0]?.path;
}

function rawString(raw: unknown, ...keys: string[]): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return (value as string[]).join(" ");
    }
  }
  return undefined;
}

function toToolInput(
  agentId: AcpAgentId,
  tool: ToolState,
  needsApproval: boolean,
  leoToolCallId: string,
): AcpToolCallInput {
  const diffContent = tool.content.find((item) => item.type === "diff");
  const command = tool.kind === "execute" ? rawString(tool.rawInput, "command", "cmd") : undefined;
  const path =
    firstLocationPath(tool) ??
    (diffContent && diffContent.type === "diff" ? diffContent.path : undefined) ??
    rawString(tool.rawInput, "file_path", "path", "abs_path");
  return {
    agentId,
    acpToolCallId: tool.id,
    leoToolCallId,
    title: tool.title,
    kind: tool.kind,
    needsApproval,
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(diffContent && diffContent.type === "diff"
      ? {
          diff: {
            path: diffContent.path,
            oldText: diffContent.oldText ?? null,
            newText: diffContent.newText,
          },
        }
      : {}),
  };
}

function summarizeTool(tool: ToolState): AcpToolCallOutput {
  const texts: string[] = [];
  const diffs: NonNullable<AcpToolCallOutput["diffs"]> = [];
  for (const item of tool.content) {
    if (item.type === "content") {
      const text = contentText(item.content);
      if (text) texts.push(text);
    } else if (item.type === "diff") {
      diffs.push({ path: item.path, oldText: item.oldText ?? null, newText: item.newText });
    } else if (item.type === "terminal") {
      texts.push(`[terminal ${item.terminalId}]`);
    }
  }
  if (texts.length === 0 && typeof tool.rawOutput === "string") texts.push(tool.rawOutput);
  if (texts.length === 0 && tool.rawOutput && typeof tool.rawOutput === "object") {
    const output = rawString(tool.rawOutput, "output", "stdout", "result", "content");
    if (output) texts.push(output);
  }
  const status = tool.status === "failed" ? "failed" : tool.status === "completed" ? "completed" : "cancelled";
  return {
    status,
    title: tool.title,
    kind: tool.kind,
    text: texts.join("\n").slice(0, 64 * 1024),
    ...(diffs.length > 0 ? { diffs } : {}),
  };
}

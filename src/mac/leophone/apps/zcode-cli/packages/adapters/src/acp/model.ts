// [leo][WP-21] 把 ACP agent 包成 LeoBot 运行时的 Model。
// 一轮里 agent 自己跑完所有步骤；运行时眼里它是「先说一段话、再调一次 AcpToolCall、再继续」的模型：
//   - 新的用户消息 → session/prompt；
//   - 每个 ACP 工具调用 → 一次 AcpToolCall（运行时执行：权限档、审批卡、工具卡与持久化都复用）；
//   - 运行时把工具结果送回来时 → 继续消费 agent 的后续更新，直到 stopReason。
// 会话上下文由 agent 自己维护，所以只把最新一条用户输入发过去；历史与工具清单忽略。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ContentBlock, PlanEntry } from "@agentclientprotocol/sdk";
import {
  createModelId,
  createModelProviderId,
  type Model,
  type ModelEvent,
  type ModelId,
  type ModelInputMessage,
  type ModelOptionSpecs,
  type ModelProperties,
  type ModelProviderId,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";
import {
  ACP_COMMANDS_FILE,
  ACP_PROVIDER_ID,
  ACP_TOOL_NAME,
  acpAgentInfo,
  parseAcpCommandsStore,
  recordAcpAgentCommands,
  type AcpAgentCommand,
  type AcpAgentId,
} from "@zcode/shared/acp";
import { detectAcpAgent, resolveAcpLaunch, type AcpEnvironment } from "./catalog.js";
import { acpUnavailableError, appendStderrTail, describeAcpFailure, type AcpAgentError } from "./errors.js";
import { spawnAcpAgent, type AcpAgentConnection } from "./process.js";
import { AcpSessionHost } from "./session.js";

const ACP_PROPERTIES: ModelProperties = {
  requiresMfjsToolSchema: false,
  contextWindow: 200_000,
  inputFormat: {
    supportsText: true,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: false,
  supportsNativeWebSearch: false,
  supportsMidConversationSystem: true,
};

const ACP_OPTION_SPECS: ModelOptionSpecs = {
  reasoningLevel: { values: ["default"], map: "{}" },
  maxOutputTokens: { max: 128_000, map: "{}" },
};

/** 每个 LeoBot 会话一个 agent 进程；会话 id 落盘，重启后用 session/load 接上。 */
export class AcpSessionManager {
  readonly #entries = new Map<
    string,
    { host: AcpSessionHost; connection: Promise<AcpAgentConnection> }
  >();
  readonly #environment: AcpEnvironment;
  readonly #statePath: string;
  readonly #commandsPath: string;
  readonly #connect: typeof spawnAcpAgent;
  readonly #logger: { warn(message: string, context?: Record<string, unknown>): void } | undefined;
  /** [fix-remote] 每个 LeoBot 会话最近的 agent stderr（失败时附在错误里）；进程重启时清空。 */
  readonly #stderrTails = new Map<string, string[]>();

  constructor(
    options: {
      environment?: AcpEnvironment;
      statePath?: string;
      commandsPath?: string;
      connect?: typeof spawnAcpAgent;
      logger?: { warn(message: string, context?: Record<string, unknown>): void };
    } = {},
  ) {
    this.#environment = options.environment ?? {};
    const root = process.env.ZCODE_HOME?.trim() || join(homedir(), ".leophoneagent");
    this.#statePath = options.statePath ?? join(root, "cli", "acp-sessions.json");
    this.#commandsPath = options.commandsPath ?? join(dirname(this.#statePath), ACP_COMMANDS_FILE);
    this.#connect = options.connect ?? spawnAcpAgent;
    this.#logger = options.logger;
  }

  /** 取（必要时启动）某个 LeoBot 会话对应的 agent。 */
  async ensure(
    leoSessionId: string,
    agentId: AcpAgentId,
    cwd: string,
  ): Promise<{ host: AcpSessionHost; connection: AcpAgentConnection }> {
    let entry = this.#entries.get(leoSessionId);
    if (entry && entry.host.agentId !== agentId) {
      this.dispose(leoSessionId);
      entry = undefined;
    }
    if (!entry) {
      const host = new AcpSessionHost(agentId, {
        onCommands: (commands) => this.#writeCommands(agentId, cwd, commands),
      });
      const launch = resolveAcpLaunch(agentId, this.#environment);
      const tail: string[] = [];
      this.#stderrTails.set(leoSessionId, tail);
      const connection = launch
        ? this.#connect(launch, {
            host,
            cwd,
            resumeSessionId: this.#readState()[leoSessionId]?.acpSessionId,
            onStderr: (chunk) => {
              appendStderrTail(tail, chunk);
              this.#logger?.warn("ACP agent stderr", { agentId, chunk: chunk.slice(0, 2000) });
            },
            onExit: (code, signal) => {
              // 进程没了：丢掉这条死连接（下一轮重新拉起），进行中的回合以错误结束。
              if (this.#entries.get(leoSessionId)?.host === host) this.#entries.delete(leoSessionId);
              host.failTurn(new Error(`ACP agent 已退出（code=${code ?? "null"} signal=${signal ?? "null"}）`));
            },
          })
        : Promise.reject(
            acpUnavailableError(agentId, detectAcpAgent(agentId, this.#environment).unavailableReason),
          );
      entry = { host, connection };
      this.#entries.set(leoSessionId, entry);
      connection.then(
        (connected) => this.#writeState(leoSessionId, agentId, connected.sessionId),
        () => {
          if (this.#entries.get(leoSessionId)?.host === host) this.#entries.delete(leoSessionId);
        },
      );
    }
    return { host: entry.host, connection: await entry.connection };
  }

  /** [fix-remote] 把失败包成「哪个 agent、什么原因、怎么修 + stderr 尾部」的错误。 */
  describeFailure(leoSessionId: string, agentId: AcpAgentId, error: unknown): AcpAgentError {
    return describeAcpFailure({ agentId, error, stderrTail: this.#stderrTails.get(leoSessionId) ?? [] });
  }

  host(leoSessionId: string): AcpSessionHost | undefined {
    return this.#entries.get(leoSessionId)?.host;
  }

  dispose(leoSessionId: string): void {
    const entry = this.#entries.get(leoSessionId);
    if (!entry) return;
    this.#entries.delete(leoSessionId);
    this.#stderrTails.delete(leoSessionId);
    void entry.host.cancel();
    entry.connection.then((connected) => connected.dispose(), () => undefined);
  }

  disposeAll(): void {
    for (const id of [...this.#entries.keys()]) this.dispose(id);
  }

  #writeCommands(agentId: AcpAgentId, cwd: string, commands: readonly AcpAgentCommand[]): void {
    try {
      let current: unknown;
      try {
        current = JSON.parse(readFileSync(this.#commandsPath, "utf8"));
      } catch {
        current = undefined;
      }
      const next = recordAcpAgentCommands(parseAcpCommandsStore(current), agentId, cwd, commands);
      mkdirSync(dirname(this.#commandsPath), { recursive: true });
      writeFileSync(this.#commandsPath, JSON.stringify(next, null, 2));
    } catch (error) {
      this.#logger?.warn("ACP 斜杠命令写入失败", { error: String(error) });
    }
  }

  #readState(): Record<string, { agentId: string; acpSessionId: string }> {
    try {
      return JSON.parse(readFileSync(this.#statePath, "utf8")) as Record<
        string,
        { agentId: string; acpSessionId: string }
      >;
    } catch {
      return {};
    }
  }

  #writeState(leoSessionId: string, agentId: AcpAgentId, acpSessionId: string): void {
    try {
      const state = this.#readState();
      state[leoSessionId] = { agentId, acpSessionId };
      mkdirSync(dirname(this.#statePath), { recursive: true });
      writeFileSync(this.#statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      this.#logger?.warn("ACP 会话映射写入失败", { error: String(error) });
    }
  }
}

export interface AcpModelOptions {
  agentId: AcpAgentId;
  leoSessionId: string;
  cwd: () => string;
  manager: AcpSessionManager;
}

/** 去掉运行时注入的 system-reminder 等元信息，只留用户真正输入的文字。 */
function userText(message: ModelInputMessage): string {
  const raw =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter(Boolean)
          .join("\n\n");
  return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function userImages(message: ModelInputMessage): ContentBlock[] {
  if (typeof message.content === "string") return [];
  const images: ContentBlock[] = [];
  for (const block of message.content) {
    if (block.type !== "image") continue;
    // dataUrl = data:<mime>;base64,<data>
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(block.dataUrl);
    if (match) images.push({ type: "image", data: match[2]!, mimeType: match[1]! });
  }
  return images;
}

function lastRealUserIndex(messages: readonly ModelInputMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && userText(message).length > 0) return index;
    if (message.role === "assistant" || message.role === "tool") return -1;
  }
  return -1;
}

/** 上一步交给运行时、但没有被执行（被拒绝）的 AcpToolCall。 */
function unexecutedAcpCalls(messages: readonly ModelInputMessage[]): string[] {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const calls = (lastAssistant?.toolCalls ?? []).filter((call) => call.name === ACP_TOOL_NAME);
  const failed = new Set(
    messages
      .filter((message) => message.role === "tool" && message.isError === true && message.toolCallId)
      .map((message) => message.toolCallId!),
  );
  return calls.filter((call) => failed.has(call.id)).map((call) => call.id);
}

function planToTodos(
  entries: readonly PlanEntry[],
): Array<{ content: string; status: string; priority: string }> {
  return entries
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => ({
      content: entry.content,
      status:
        entry.status === "completed"
          ? "completed"
          : entry.status === "in_progress"
            ? "in_progress"
            : "pending",
      priority: entry.priority === "high" || entry.priority === "low" ? entry.priority : "medium",
    }));
}

export class AcpModel implements Model {
  readonly providerId: ModelProviderId = createModelProviderId(ACP_PROVIDER_ID);
  readonly modelId: ModelId;
  readonly agentId: AcpAgentId;
  readonly displayName: string;
  readonly properties = ACP_PROPERTIES;
  readonly optionSpecs = ACP_OPTION_SPECS;
  readonly options = { reasoningLevel: "default" };
  readonly #options: AcpModelOptions;
  #planSignature = "";

  constructor(options: AcpModelOptions) {
    this.#options = options;
    this.agentId = options.agentId;
    this.modelId = createModelId(options.agentId);
    this.displayName = acpAgentInfo(options.agentId).name;
  }

  bind(): Model {
    return this;
  }

  /** 辅助调用（标题、摘要等）不打扰 agent：给一个本地的确定性结果。 */
  async generateText(request: ModelRequest): Promise<ModelResult> {
    const user = [...request.messages].reverse().find((message) => message.role === "user");
    const text = user ? userText(user).split("\n")[0]!.slice(0, 40) : "";
    return { text, finishReason: "stop", usage: {} };
  }

  async *streamText(request: ModelRequest): AsyncIterable<ModelEvent> {
    const { manager, leoSessionId, agentId, cwd } = this.#options;
    let host: AcpSessionHost;
    try {
      ({ host } = await manager.ensure(leoSessionId, agentId, cwd()));
    } catch (error) {
      throw manager.describeFailure(leoSessionId, agentId, error);
    }
    const signal = request.abortSignal;
    const userIndex = lastRealUserIndex(request.messages);
    if (userIndex >= 0) {
      host.rejectPending(host.pendingApprovalIds());
      const message = request.messages[userIndex]!;
      host.startTurn([{ type: "text", text: userText(message) }, ...userImages(message)]);
    } else {
      host.rejectPending(unexecutedAcpCalls(request.messages));
      if (!host.turnActive) {
        // 运行时在 agent 已收尾之后又来续一步（例如工具结果回填）：直接结束本轮。
        yield { type: "start" };
        yield { type: "finish", finishReason: "stop", usage: {} };
        return;
      }
    }

    yield { type: "start" };
    let openText: string | undefined;
    let openReasoning: string | undefined;
    let blockSeq = 0;
    const closeOpen = function* (): Generator<ModelEvent> {
      if (openText) yield { type: "text_end", id: openText };
      if (openReasoning) yield { type: "reasoning_end", id: openReasoning };
      openText = undefined;
      openReasoning = undefined;
    };

    const onAbort = () => void host.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const event = await host.next(signal);
        switch (event.kind) {
          case "text": {
            if (openReasoning) {
              yield { type: "reasoning_end", id: openReasoning };
              openReasoning = undefined;
            }
            if (!openText) {
              openText = `acp-text-${++blockSeq}`;
              yield { type: "text_start", id: openText };
            }
            yield { type: "text_delta", id: openText, text: event.text };
            break;
          }
          case "thought": {
            if (openText) {
              yield { type: "text_end", id: openText };
              openText = undefined;
            }
            if (!openReasoning) {
              openReasoning = `acp-thought-${++blockSeq}`;
              yield { type: "reasoning_start", id: openReasoning };
            }
            yield { type: "reasoning_delta", id: openReasoning, text: event.text };
            break;
          }
          case "plan": {
            const todos = planToTodos(event.entries);
            const signature = JSON.stringify(todos);
            if (signature === this.#planSignature) break;
            this.#planSignature = signature;
            yield* closeOpen();
            yield {
              type: "tool_call",
              toolCall: { id: `acp-plan-${++blockSeq}-${Date.now()}`, name: "TodoWrite", input: { todos } },
            };
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          case "tool": {
            yield* closeOpen();
            yield {
              type: "tool_call",
              toolCall: { id: event.input.leoToolCallId, name: ACP_TOOL_NAME, input: event.input },
            };
            for (let extra = host.takeQueuedTool(); extra; extra = host.takeQueuedTool()) {
              yield {
                type: "tool_call",
                toolCall: { id: extra.input.leoToolCallId, name: ACP_TOOL_NAME, input: extra.input },
              };
            }
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          case "stop": {
            yield* closeOpen();
            if (event.stopReason === "refusal") {
              yield { type: "text_start", id: "acp-refusal" };
              yield { type: "text_delta", id: "acp-refusal", text: "（agent 拒绝了这次请求）" };
              yield { type: "text_end", id: "acp-refusal" };
            }
            yield {
              type: "finish",
              finishReason: event.stopReason === "max_tokens" ? "length" : "stop",
              usage: event.usage ?? {},
            };
            return;
          }
          case "error":
            yield* closeOpen();
            yield { type: "error", error: manager.describeFailure(leoSessionId, agentId, event.error) };
            return;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

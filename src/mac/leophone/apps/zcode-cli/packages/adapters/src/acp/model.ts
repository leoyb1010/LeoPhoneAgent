// [leo][WP-21] 把 ACP agent 包成 LeoBot 运行时的 Model。
// 一轮里 agent 自己跑完所有步骤；运行时眼里它是「先说一段话、再调一次 AcpToolCall、再继续」的模型：
//   - 新的用户消息 → session/prompt；
//   - 每个 ACP 工具调用 → 一次 AcpToolCall（运行时执行：权限档、审批卡、工具卡与持久化都复用）；
//   - 运行时把工具结果送回来时 → 继续消费 agent 的后续更新，直到 stopReason。
// 会话上下文由 agent 自己维护，所以只把最新一条用户输入发过去；历史与工具清单忽略。
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
import { ACP_PROVIDER_ID, ACP_TOOL_NAME, acpAgentInfo, type AcpAgentId } from "@zcode/shared/acp";
import type { AcpSessionManager } from "./manager.js";
import type { AcpSessionHost } from "./session.js";

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
            const tokens = (event.usage?.inputTokens ?? 0) + (event.usage?.outputTokens ?? 0);
            if (event.empty && tokens === 0 && event.stopReason !== "cancelled" && event.stopReason !== "refusal") {
              yield { type: "error", error: manager.describeEmptyTurn(leoSessionId, agentId, event.stopReason) };
              return;
            }
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

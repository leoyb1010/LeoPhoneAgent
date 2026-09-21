import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";

import { loggedInModels, oauthRuntime } from "./oauthRuntime.js";

/**
 * [leo] OpenAI 兼容的本机模型代理:`/v1/models` 与 `/v1/chat/completions`。
 *
 * LeoPhoneAgent 的 Agent 说 OpenAI chat-completions;订阅账号(Claude / ChatGPT /
 * Copilot)各有各的协议和鉴权。这里把请求翻成 pi 的 Context,交给 ModelRuntime
 * 用对应账号去调,再把事件流翻回 OpenAI 的 SSE。工具调用双向都支持,Agent 的
 * 读写文件、跑命令照常可用。
 *
 * 模型 id 形如 `anthropic/claude-sonnet-4-5`:斜杠前是哪一家,后面是那家的模型。
 */

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: unknown } }>;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
}

function textOf(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function partsOf(content: OpenAIMessage["content"]): (TextContent | ImageContent)[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "image_url") {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
      if (match) parts.push({ type: "image", mimeType: match[1]!, data: match[2]! });
    }
  }
  return parts;
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** OpenAI messages → pi Context。system / developer 合并成 systemPrompt。 */
export function toPiContext(request: OpenAIRequest): Context {
  const system: string[] = [];
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  const now = Date.now();
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      system.push(textOf(message.content));
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: partsOf(message.content), timestamp: now });
      continue;
    }
    if (message.role === "assistant") {
      const content: (TextContent | ToolCall)[] = [];
      const text = textOf(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of message.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name);
        content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: safeJson(call.function.arguments) });
      }
      messages.push({
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "leo-proxy",
        model: request.model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: now,
      } as unknown as AssistantMessage);
      continue;
    }
    if (message.role === "tool") {
      const callId = message.tool_call_id ?? "";
      messages.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: toolNames.get(callId) ?? message.name ?? "tool",
        content: partsOf(message.content).length > 0 ? partsOf(message.content) : [{ type: "text", text: textOf(message.content) }],
        isError: false,
        timestamp: now,
      });
    }
  }
  const tools: Tool[] | undefined = request.tools?.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    // OpenAI 的 parameters 就是 JSON Schema;pi 的 Tool 参数也是 JSON Schema(TypeBox 产物同构)。
    parameters: (tool.function.parameters ?? { type: "object", properties: {} }) as Tool["parameters"],
  }));
  return {
    ...(system.length > 0 ? { systemPrompt: system.join("\n\n") } : {}),
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

function finishReason(stopReason: string): "stop" | "length" | "tool_calls" {
  if (stopReason === "toolUse") return "tool_calls";
  if (stopReason === "length") return "length";
  return "stop";
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export async function handleModelsRequest(res: ServerResponse): Promise<void> {
  const models = await loggedInModels();
  sendJson(res, 200, {
    object: "list",
    data: models.map((model) => ({ id: model.id, object: "model", owned_by: model.id.split("/")[0], name: model.name })),
  });
}

export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const request = body as unknown as OpenAIRequest;
  const [providerId, ...rest] = String(request.model ?? "").split("/");
  const modelId = rest.join("/");
  const runtime = await oauthRuntime();
  const model = providerId && modelId ? runtime.getModel(providerId, modelId) : undefined;
  if (!model) {
    sendJson(res, 404, { error: { message: `模型不存在或该订阅账号没登录:${request.model}`, type: "invalid_request_error" } });
    return;
  }

  const abort = new AbortController();
  req.on("close", () => abort.abort());
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  const stream = runtime.streamSimple(model, toPiContext(request), {
    signal: abort.signal,
    ...(maxTokens ? { maxTokens } : {}),
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
  } as never);

  const id = `chatcmpl-leo-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!request.stream) {
    let final: AssistantMessage | null = null;
    let errorText: string | null = null;
    for await (const event of stream) {
      if (event.type === "done") final = event.message;
      if (event.type === "error") errorText = event.error.errorMessage ?? "模型调用失败";
    }
    if (!final) {
      sendJson(res, 502, { error: { message: errorText ?? "模型没有返回", type: "upstream_error" } });
      return;
    }
    const text = final.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("");
    const calls = final.content.filter((part): part is ToolCall => part.type === "toolCall");
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text || null,
            ...(calls.length > 0
              ? {
                  tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                  })),
                }
              : {}),
          },
          finish_reason: finishReason(final.stopReason),
        },
      ],
      usage: {
        prompt_tokens: final.usage.input,
        completion_tokens: final.usage.output,
        total_tokens: final.usage.totalTokens,
      },
    });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );

  chunk({ role: "assistant" });
  let toolIndex = 0;
  try {
    for await (const event of stream) {
      if (event.type === "text_delta") chunk({ content: event.delta });
      else if (event.type === "thinking_delta") chunk({ reasoning_content: event.delta });
      else if (event.type === "toolcall_end") {
        // 工具参数一次性给全:Agent 反正要等参数完整才执行,流式拼 JSON 只会多出半截解析错误。
        chunk({
          tool_calls: [
            {
              index: toolIndex,
              id: event.toolCall.id,
              type: "function",
              function: { name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments ?? {}) },
            },
          ],
        });
        toolIndex += 1;
      } else if (event.type === "done") {
        chunk({}, finishReason(event.message.stopReason));
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: request.model, choices: [], usage: { prompt_tokens: event.message.usage.input, completion_tokens: event.message.usage.output, total_tokens: event.message.usage.totalTokens } })}\n\n`,
        );
      } else if (event.type === "error") {
        res.write(
          `data: ${JSON.stringify({ error: { message: event.error.errorMessage ?? "模型调用失败", type: "upstream_error" } })}\n\n`,
        );
      }
    }
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: { message: String(error), type: "upstream_error" } })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

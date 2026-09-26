// 本地 OpenAI 兼容 mock 模型：dry-run 时代替真实模型，按任务的 mock 脚本逐步回放工具调用。
// 用途是验证 eval 链路（建仓库 → 跑 CLI → 解析事件 → 检查）与 Edit/Read 的真实执行，不评估模型能力。
// - 任务由请求头 x-leo-eval-task 指定（run-eval.mjs 写进 provider 配置的 api.headers）；
// - 第 N 步 = 请求里已有 N 个 tool 结果；脚本走完后回一句总结并 stop；
// - 没带 tools 的请求（标题生成等旁路）直接回一段短文本；
// - hashline 模式（请求里的 Edit schema 带 pos）下，把"整行替换"的 old_string 自动改写成锚点操作，
//   锚点从对话里最近一次 Read 的 `行号#哈希:` 输出里取，以此端到端验证 hashline。
// 只监听 127.0.0.1，不连任何外部服务。

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const DONE_TEXT = "Done. The requested change is in place.";

export async function startMockModelServer({ tasks, port = 0 }) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const server = createServer((request, response) => {
    handle(request, response, byId).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function handle(request, response, byId) {
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    return sendJson(response, { object: "list", data: [{ id: "mock-model", object: "model" }] });
  }
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404);
    return response.end();
  }
  const body = JSON.parse(await readBody(request));
  const task = byId.get(String(request.headers["x-leo-eval-task"] ?? ""));
  logRequest(task, body);
  const reply = decideReply(body, task);
  const usage = fakeUsage(body, reply);
  if (body.stream) return streamReply(response, body, reply, usage);
  return sendJson(response, {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: reply.toolCall
          ? { role: "assistant", content: null, tool_calls: [toToolCall(reply.toolCall)] }
          : { role: "assistant", content: reply.text },
        finish_reason: reply.toolCall ? "tool_calls" : "stop",
      },
    ],
    usage,
  });
}

function decideReply(body, task) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0 || !task) return { text: task ? task.title : "Eval task" };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const step = messages.filter((message) => message.role === "tool").length;
  const scripted = task.mock[step];
  if (!scripted) return { text: DONE_TEXT };
  const hashline = tools.some(
    (tool) => tool.function?.name === "Edit" && JSON.stringify(tool.function.parameters ?? {}).includes('"pos"'),
  );
  const input = hashline && scripted.tool === "Edit" ? toHashlineInput(scripted.input, messages) : scripted.input;
  return { toolCall: { id: `call_${step}_${Date.now()}`, name: scripted.tool, input } };
}

/** 整行替换 → hashline 锚点操作；找不到锚点的保持文本替换（hashline 模式同样接受）。 */
function toHashlineInput(input, messages) {
  const readOutput = [...messages].reverse().find((message) => message.role === "tool" && typeof message.content === "string" && /^\s*\d+#[A-Z]{2}:/m.test(message.content))?.content;
  if (!readOutput) return input;
  const anchors = new Map();
  for (const line of readOutput.split("\n")) {
    const match = /^(\d+#[A-Z]{2}):(.*)$/.exec(line);
    if (match && !anchors.has(match[2])) anchors.set(match[2], match[1]);
  }
  const convert = (edit) => {
    if (edit.old_string === undefined || edit.old_string.includes("\n")) return edit;
    const anchor = anchors.get(edit.old_string);
    return anchor ? { op: "replace", pos: anchor, lines: edit.new_string.split("\n") } : edit;
  };
  if (Array.isArray(input.edits)) return { ...input, edits: input.edits.map(convert) };
  if (input.old_string !== undefined) {
    const converted = convert({ old_string: input.old_string, new_string: input.new_string });
    if (converted.op) return { file_path: input.file_path, edits: [converted] };
  }
  return input;
}

/** LEO_EVAL_MOCK_LOG=<file> 时逐条记下请求概况（工具名、系统提示长度、是否带 prompt_cache_key），排查用。 */
function logRequest(task, body) {
  const logPath = process.env.LEO_EVAL_MOCK_LOG;
  if (!logPath) return;
  const system = (body.messages ?? []).filter((message) => message.role === "system");
  appendFileSync(
    logPath,
    `${JSON.stringify({
      task: task?.id,
      tools: (body.tools ?? []).map((tool) => tool.function?.name).sort(),
      systemChars: JSON.stringify(system).length,
      promptCacheKey: typeof body.prompt_cache_key === "string",
    })}\n`,
  );
}

function toToolCall(call) {
  return { id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } };
}

function fakeUsage(body, reply) {
  const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  const completionTokens = Math.ceil(JSON.stringify(reply).length / 4);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: Math.floor(promptTokens * 0.5) },
  };
}

function streamReply(response, body, reply, usage) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const base = { id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
  const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  if (reply.toolCall) {
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toToolCall(reply.toolCall) }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    send({ ...base, choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  send({ ...base, choices: [], usage });
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendJson(response, payload) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { TASKS } = await import("./tasks.mjs");
  const port = Number(process.argv[2] ?? 0);
  const server = await startMockModelServer({ tasks: TASKS, port });
  console.log(`mock model listening at ${server.url}`);
}

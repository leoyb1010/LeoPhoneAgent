// 解析 `zcode -p --output-format stream-json` 的事件流：每行一个事件，最后一行 type=result。
// 统计每种工具的调用次数、Edit 失败（tool.updated kind=error）、最终 usage（含缓存命中）。
// 子代理镜像过来的工具事件（toolCallId 以 tool_subagent_ 开头）单独计数，不混进主会话。

const SUBAGENT_TOOL_PREFIX = "tool_subagent_";
const MAX_RECORDED_FAILURES = 5;
const MAX_FAILURE_MESSAGE_CHARS = 400;

export function summarizeEvents(stdout) {
  const toolNames = new Map();
  const tools = {};
  const editFailureMessages = [];
  let editFailures = 0;
  // Edit 入参形态：单段 old_string / 多段 edits[] / 含 hashline 锚点，用来观察模型实际怎么用 Edit
  const editShapes = { single: 0, multi: 0, anchored: 0 };
  let subagentToolCalls = 0;
  let result;
  let parseErrors = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (event.type === "result") {
      result = event;
      continue;
    }
    if (event.type !== "tool.updated" || typeof event.payload !== "object" || event.payload === null) continue;
    const payload = event.payload;
    const toolCallId = String(payload.toolCallId ?? "");
    if (toolCallId.startsWith(SUBAGENT_TOOL_PREFIX)) {
      if (payload.kind === "started") subagentToolCalls += 1;
      continue;
    }
    if ((payload.kind === "scheduled" || payload.kind === "started") && typeof payload.toolName === "string") {
      if (!toolNames.has(toolCallId)) {
        toolNames.set(toolCallId, payload.toolName);
        tools[payload.toolName] = (tools[payload.toolName] ?? 0) + 1;
        if (payload.toolName === "Edit") countEditShape(editShapes, payload.input);
      }
      continue;
    }
    if (payload.kind === "error" && toolNames.get(toolCallId) === "Edit") {
      editFailures += 1;
      if (editFailureMessages.length < MAX_RECORDED_FAILURES) {
        editFailureMessages.push(String(payload.error?.message ?? "").slice(0, MAX_FAILURE_MESSAGE_CHARS));
      }
    }
  }

  const usage = result?.usage;
  return {
    tools,
    editFailures,
    editFailureMessages,
    editShapes,
    subagentToolCalls,
    usage: usage
      ? {
          modelRequests: usage.modelRequestCount,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        }
      : undefined,
    response: typeof result?.response === "string" ? result.response.slice(0, 500) : undefined,
    sawResult: Boolean(result),
    parseErrors,
  };
}

function countEditShape(shapes, input) {
  const record = typeof input === "string" ? safeParse(input) : input;
  const edits = Array.isArray(record?.edits) ? record.edits : undefined;
  if (edits?.some((edit) => typeof edit?.pos === "string" || typeof edit?.op === "string")) shapes.anchored += 1;
  else if (edits && edits.length > 1) shapes.multi += 1;
  else shapes.single += 1;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

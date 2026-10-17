import type { McpPort } from "@zcode/contracts";

import {
  extractTreasuryRecallTerms,
  formatTreasuryRecallAttachment,
  mergeTreasurySearchHits,
  parseTreasuryToolPayload,
  readTreasuryRecallItems,
  TREASURY_RECALL_BODY_CHARS,
  TREASURY_RECALL_SERVER_NAME,
  type TreasuryRecallItem,
} from "../../memory/treasury-recall.js";
import { findLatestMemoryRecallQuery } from "../../memory/recall/index.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isMainMemoryTaskType } from "./project-memory.js";

/** 等 MCP 启动的上限:藏宝阁不在线就算了,不能拖慢第一次模型请求。 */
const TREASURY_MCP_STARTUP_WAIT_MS = 1_500;
/** 单次检索调用上限(本地 HTTP,正常是毫秒级)。 */
const TREASURY_CALL_TIMEOUT_MS = 2_000;

// 同一会话里已经附过的条目不再重复附;按 runtime 记,不进持久化。
const recalledIdsByRuntime = new WeakMap<object, Set<string>>();

export interface TreasuryRecallDeps {
  mcpPort: Pick<McpPort, "callTool">;
  waitForServer: () => Promise<boolean>;
  signal?: AbortSignal;
}

/**
 * 纯流程(便于单测):关键词 → 逐词 treasury_search → 合并 → treasury_get 取正文。
 * 任何一步失败都返回空,召回是锦上添花,不能让回合失败。
 */
export async function recallTreasuryItems(
  query: string,
  deps: TreasuryRecallDeps,
  excludeIds: ReadonlySet<string> = new Set(),
): Promise<TreasuryRecallItem[]> {
  const terms = extractTreasuryRecallTerms(query);
  if (terms.length === 0) return [];
  if (!(await deps.waitForServer())) return [];
  const call = (toolName: string, args: Record<string, unknown>) =>
    deps.mcpPort
      .callTool(
        { serverName: TREASURY_RECALL_SERVER_NAME, toolName, arguments: args, runtimeScope: "main" },
        { signal: deps.signal, timeoutMs: TREASURY_CALL_TIMEOUT_MS },
      )
      .then((result) =>
        parseTreasuryToolPayload({
          content: result.content.map((block) => ({
            type: String(block.type),
            ...("text" in block && typeof block.text === "string" ? { text: block.text } : {}),
          })),
          structuredContent: result.structuredContent,
          isError: result.isError,
        }),
      )
      .catch(() => undefined);
  const perTerm = await Promise.all(
    terms.map((term) => call("treasury_search", { query: term, limit: 5 })),
  );
  const hits = mergeTreasurySearchHits(perTerm, excludeIds);
  if (hits.length === 0) return [];
  const ids = hits.map((hit) => hit.id);
  const detail = await call("treasury_get", {
    ids,
    include_body: true,
    max_chars_per_item: TREASURY_RECALL_BODY_CHARS,
  });
  return readTreasuryRecallItems(detail, ids);
}

function isTreasuryRecallEnabled(runtime: AgentRuntimeInternal): boolean {
  const memory = runtime.config.memory;
  if (memory?.treasuryRecall === false) return false;
  return isMainMemoryTaskType(runtime.config.taskType);
}

async function waitForTreasuryServer(runtime: AgentRuntimeInternal): Promise<boolean> {
  const startup = runtime.mcpStartupPromise;
  if (!startup) return false;
  const snapshot = await Promise.race([
    startup.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, TREASURY_MCP_STARTUP_WAIT_MS)),
  ]);
  return snapshot?.statuses[TREASURY_RECALL_SERVER_NAME]?.status === "connected";
}

/** 本回合第一次模型请求前调用:命中就返回一条 relevant_memory 提醒(同时写进历史)。 */
export async function prepareTreasuryRecallEntry(
  runtime: AgentRuntimeInternal,
  turnAbortSignal: AbortSignal,
): Promise<RuntimeMessageEntry | undefined> {
  if (!runtime.mcpPort || !isTreasuryRecallEnabled(runtime)) return undefined;
  const query = findLatestMemoryRecallQuery(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  if (!query?.trim()) return undefined;
  const recalled = recalledIdsByRuntime.get(runtime) ?? new Set<string>();
  const items = await recallTreasuryItems(
    query,
    {
      mcpPort: runtime.mcpPort,
      signal: turnAbortSignal,
      waitForServer: () => waitForTreasuryServer(runtime),
    },
    recalled,
  ).catch(() => []);
  if (items.length === 0 || turnAbortSignal.aborted) return undefined;
  for (const item of items) recalled.add(item.id);
  recalledIdsByRuntime.set(runtime, recalled);
  const entry = systemReminderAttachmentEntry(
    "relevant_memory",
    formatTreasuryRecallAttachment(items),
  );
  runtime.messageHistory.addEntries([entry]);
  return entry;
}

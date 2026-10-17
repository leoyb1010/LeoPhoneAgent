// [leo][wp-61] 记忆统一:藏宝阁接进同一召回入口。用真实的藏宝阁存储(node:sqlite,隔离目录)
// + 与 leo-treasury MCP 完全一致的返回形状(工具结果 JSON 放在第一个 text 块),证明
// 「问上次那个端口是多少」能把藏宝阁里记过的端口条目召回成 relevant_memory 提醒。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { McpCallToolRequest, McpToolCallResult } from "@zcode/contracts";

import {
  extractTreasuryRecallTerms,
  formatTreasuryRecallAttachment,
} from "../../src/memory/treasury-recall.js";
import { isMemoryRecallQueryEligible } from "../../src/memory/recall/selector.js";
import { resolveRuntimeProjectMemoryRetrievalBranch } from "../../src/memory/project-memory-retrieval-branch.js";
import { recallTreasuryItems } from "../../src/runtime/helpers/treasury-recall.js";

const leoHome = mkdtempSync(join(tmpdir(), "leo-treasury-recall-"));
process.env["LEOAGENT_HOME"] = leoHome;
test.after(() => rmSync(leoHome, { recursive: true, force: true }));

async function realTreasuryPort() {
  // 隔离目录在 import 前设好:leoPaths 在模块加载时读 LEOAGENT_HOME。
  const { TreasuryStore } = await import(
    "../../../../../../packages/desktop/src/host/leo/treasuryStore.js"
  );
  const { executeTreasuryTool } = await import(
    "../../../../../../packages/desktop/src/host/leo/treasuryTools.js"
  );
  const store = new TreasuryStore();
  const calls: McpCallToolRequest[] = [];
  const mcpPort = {
    async callTool(request: McpCallToolRequest): Promise<McpToolCallResult> {
      calls.push(request);
      const payload = executeTreasuryTool(store, request.toolName, request.arguments ?? {});
      // 与 packages/desktop/leo/treasury-mcp.mjs 的 tools/call 返回形状一致。
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  };
  return { store, mcpPort, calls };
}

test("关键词:剥掉指代 / 疑问 / 语气词,中英混说都能抽出可匹配的词", () => {
  assert.deepEqual(extractTreasuryRecallTerms("问上次那个端口是多少"), ["端口"]);
  assert.deepEqual(extractTreasuryRecallTerms("上次那个 relay 端口是多少？"), ["relay", "端口"]);
  assert.deepEqual(extractTreasuryRecallTerms("什么？"), []);
});

test("中文整句也能进 Semantic Recall(上游只认含空白的句子)", () => {
  assert.equal(isMemoryRecallQueryEligible("上次那个端口是多少"), true);
  assert.equal(isMemoryRecallQueryEligible("端口"), false);
  assert.equal(isMemoryRecallQueryEligible("what was that port"), true);
});

test("Semantic Recall 由桌面设置显式打开;用户关掉或模型跑不了 JSON Schema selector 时回到索引分支", () => {
  const capable = { properties: { supportsJsonSchemaOutput: true } } as never;
  const incapable = { properties: { supportsJsonSchemaOutput: false } } as never;
  assert.equal(
    resolveRuntimeProjectMemoryRetrievalBranch({ semanticRecall: true }, capable),
    "semantic-recall",
  );
  // CLI/TUI 不传开关时保持上游默认（关）。
  assert.equal(resolveRuntimeProjectMemoryRetrievalBranch(undefined, capable), "default-index");
  assert.equal(
    resolveRuntimeProjectMemoryRetrievalBranch({ semanticRecall: false }, capable),
    "default-index",
  );
  assert.equal(
    resolveRuntimeProjectMemoryRetrievalBranch({ semanticRecall: true }, incapable),
    "default-index",
  );
});

test("问「上次那个端口是多少」能从藏宝阁召回端口条目", async () => {
  const { store, mcpPort, calls } = await realTreasuryPort();
  const portNote = store.save({
    kind: "note",
    title: "relay 服务端口",
    content: "LeoBot relay 跑在 38473 端口,手机直连走 /treasury/v1。",
    tags: ["relay", "配置"],
    source_uri: null,
  });
  store.save({
    kind: "note",
    title: "周末买菜清单",
    content: "鸡蛋、牛奶",
    tags: [],
    source_uri: null,
  });

  const items = await recallTreasuryItems("问上次那个端口是多少", {
    mcpPort,
    waitForServer: async () => true,
  });

  assert.deepEqual(
    items.map((item) => item.id),
    [portNote.id],
  );
  assert.match(items[0]!.body, /38473/u);
  assert.deepEqual(
    calls.map((call) => [call.serverName, call.toolName]),
    [
      ["leo-treasury", "treasury_search"],
      ["leo-treasury", "treasury_get"],
    ],
  );
  const reminder = formatTreasuryRecallAttachment(items);
  assert.match(reminder, /Treasury/u);
  assert.match(reminder, /untrusted/u);
  assert.match(reminder, /relay 服务端口/u);
  assert.match(reminder, /38473/u);

  // 同一会话已附过的条目不再重复附。
  const again = await recallTreasuryItems(
    "问上次那个端口是多少",
    { mcpPort, waitForServer: async () => true },
    new Set([portNote.id]),
  );
  assert.deepEqual(again, []);
});

test("藏宝阁不在线时什么也不做,不抛错", async () => {
  const { mcpPort, calls } = await realTreasuryPort();
  const items = await recallTreasuryItems("问上次那个端口是多少", {
    mcpPort,
    waitForServer: async () => false,
  });
  assert.deepEqual(items, []);
  assert.equal(calls.length, 0);
});

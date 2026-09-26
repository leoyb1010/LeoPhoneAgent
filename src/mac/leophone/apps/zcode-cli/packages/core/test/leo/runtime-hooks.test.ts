// [leo] 过早 length 截断判定、工具顺序稳定性，以及上游文件里 [leo] 钩子仍在（同步上游时被冲掉会红）。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isLeoPrematureLengthStop, recoverLeoPrematureLengthStop } from "../../src/runtime/leo/premature-length.js";
import { isModelContextExceededError } from "../../src/runtime/helpers/model-errors.js";
import { orderProviderVisibleToolContracts } from "../../src/tool/provider-visible-order.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFile(join(here, "../../src", relative), "utf8");

test("premature length stop = output budget squeezed by context below 8K, once per step", () => {
  const squeezed = { baseline: 32_000, step: 3_000 };
  assert.equal(isLeoPrematureLengthStop({ budget: squeezed, outputTokenContinuation: "continue", reactiveCompactAttempted: false }), true);
  assert.equal(isLeoPrematureLengthStop({ budget: squeezed, outputTokenContinuation: "exhausted", reactiveCompactAttempted: false }), true);
  // 已经压缩过一次：交回上游续写
  assert.equal(isLeoPrematureLengthStop({ budget: squeezed, outputTokenContinuation: "continue", reactiveCompactAttempted: true }), false);
  // 预算没被压缩：模型真的写满了，上游续写更合适
  assert.equal(isLeoPrematureLengthStop({ budget: { baseline: 32_000, step: 32_000 }, outputTokenContinuation: "continue", reactiveCompactAttempted: false }), false);
  // 压缩了但仍有较大预算
  assert.equal(isLeoPrematureLengthStop({ budget: { baseline: 64_000, step: 20_000 }, outputTokenContinuation: "continue", reactiveCompactAttempted: false }), false);
  assert.equal(isLeoPrematureLengthStop({ budget: squeezed, outputTokenContinuation: "none", reactiveCompactAttempted: false }), false);
});

test("premature length recovery: compact via the upstream path, then discard the partial answer", async () => {
  const calls: string[] = [];
  const base = {
    budget: { baseline: 32_000, step: 2_000 },
    outputTokenContinuation: "continue" as const,
    reactiveCompactAttempted: false,
    rapidRefillBlocked: false,
    finishReason: "length",
    rawFinishReason: undefined,
    responseLength: 42,
    logContext: {},
  };
  const recovered = await recoverLeoPrematureLengthStop({
    ...base,
    recover: async (error) => {
      calls.push(isModelContextExceededError(error) ? "compact(context_exceeded)" : "compact(other)");
      return true;
    },
    discard: async () => {
      calls.push("discard");
    },
  });
  assert.equal(recovered, true);
  assert.deepEqual(calls, ["compact(context_exceeded)", "discard"]);

  // 压缩没成：不丢弃，交回上游续写
  calls.length = 0;
  const failed = await recoverLeoPrematureLengthStop({
    ...base,
    recover: async () => {
      calls.push("compact");
      return false;
    },
    discard: async () => {
      calls.push("discard");
    },
  });
  assert.equal(failed, false);
  assert.deepEqual(calls, ["compact"]);

  // rapid-refill 熔断中：直接交回上游，不再压缩
  const blocked = await recoverLeoPrematureLengthStop({
    ...base,
    rapidRefillBlocked: true,
    recover: async () => assert.fail("must not compact"),
    discard: async () => assert.fail("must not discard"),
  });
  assert.equal(blocked, false);
});

test("provider-visible tool order is independent of registration order", () => {
  const names = ["mcp__b__z", "Read", "js", "mcp__a__y", "Bash", "SendMessage", "Edit", "CreateWorkflow"];
  const forward = orderProviderVisibleToolContracts(names.map((name) => ({ name }))).map((tool) => tool.name);
  const backward = orderProviderVisibleToolContracts([...names].reverse().map((name) => ({ name }))).map((tool) => tool.name);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ["Bash", "Edit", "Read", "CreateWorkflow", "SendMessage", "js", "mcp__a__y", "mcp__b__z"]);
});

test("upstream files still carry the [leo] hooks", async () => {
  const checks: Array<[string, RegExp[]]> = [
    ["tool/handlers/edit.ts", [/parseLeoEditRequest\(input\)/u, /planLeoMultiEdit\(/u, /withLeoFileMutationQueue\(/u, /splitLeoBom\(/u, /leoSingleEditSummary\(/u]],
    ["tool/handlers/write.ts", [/withLeoFileMutationQueue\(/u]],
    ["tool/edit-matchers.ts", [/findLeoEarlyCandidates\(/u, /normalizeLeoReplacement\(/u]],
    ["tool/handlers/read.ts", [/readLeoTextFileForModel\(context/u, /leoReadStateLimit\(/u, /leoAllowsUnchangedStub\(context, cached\)/u]],
    ["tool/handlers/read-text.ts", [/formatLeoReadTextBody\(output\)/u]],
    ["tool/handlers/index.ts", [/withLeoModelProfile\(entry, options\.leoAgent\)/u]],
    ["tool/provider-visible-order.ts", [/compareToolNamesByCodePoint/u]],
    ["tool/executor/call-runner.ts", [/readLeoEditMatchStrategies\(output\)/u]],
    ["runtime/methods/turn-model-step.ts", [/recoverLeoPrematureLengthStop\(/u, /discardLeoAttempt\(LEO_CONTEXT_OVERFLOW_DISCARDED_FINISH\)/u]],
    ["runtime/methods/message-persistence.ts", [/providerVisibility: update\?\.providerVisibility \?\? "visible"/u]],
    ["runtime/helpers/tool-allowlist.ts", [/applyLeoLeanToolAllowlist\(/u]],
    ["runtime/methods/mcp.ts", [/applyLeoLeanToolAllowlist\(this\.config/u]],
    ["runtime/methods/context.ts", [/buildLeoLeanSystemPrompt\(this\.config/u]],
    ["agent/session-history-hydrator.ts", [/providerVisibility === "hidden"\) continue;/u]],
    ["runtime/helpers/runtime-tools.ts", [/leoAgent: runtime\.config\.leoAgent/u]],
    ["runtime/methods/embedded-search-branch.ts", [/leoAgent: runtime\.config\.leoAgent/u]],
    ["runtime/methods/subagent.ts", [/leoAgent: this\.config\.leoAgent/u]],
  ];
  for (const [file, patterns] of checks) {
    const text = await source(file);
    for (const pattern of patterns) assert.match(text, pattern, `${file} lost ${pattern}`);
  }
});

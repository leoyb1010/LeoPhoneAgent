import assert from "node:assert/strict";
import test from "node:test";

import type { ZCodeStreamEvent } from "@zcode/shared";

import { ZCodeEventMapper } from "./eventMap.js";
import type { HarnessEvent } from "./journal.js";

const chunk = (content: string) => ({ type: "agent_message_chunk", content }) as unknown as ZCodeStreamEvent;

test("message deltas within the merge window become one frame, flushed by the timer", async () => {
  const deferred: HarnessEvent[] = [];
  const mapper = new ZCodeEventMapper(Date.now, (events) => deferred.push(...events), 20);
  assert.deepEqual(mapper.map(chunk("你")), []);
  assert.deepEqual(mapper.map(chunk("好")), []);
  assert.deepEqual(mapper.map(chunk("呀")), []);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(deferred, [{ event: "message.delta", delta: "你好呀" }]);
});

test("any other event flushes buffered text first, keeping order", () => {
  const deferred: HarnessEvent[] = [];
  const mapper = new ZCodeEventMapper(Date.now, (events) => deferred.push(...events), 10_000);
  mapper.map(chunk("先说"));
  const out = mapper.map({ type: "task_complete", stopReason: "success" } as unknown as ZCodeStreamEvent);
  assert.deepEqual(
    out.map((event) => event.event),
    ["message.delta", "run.completed"],
  );
  assert.equal(out[0]?.["delta"], "先说");
  // 定时器已被取消,不会再补一条。
  assert.deepEqual(mapper.flushPending(), []);
  assert.deepEqual(deferred, []);
});

test("thought after text: text goes out before the thought starts buffering", () => {
  const mapper = new ZCodeEventMapper(Date.now, () => undefined, 10_000);
  mapper.map(chunk("正文"));
  const out = mapper.map({ type: "agent_thought_chunk", content: "想" } as unknown as ZCodeStreamEvent);
  assert.deepEqual(out, [{ event: "message.delta", delta: "正文" }]);
  assert.deepEqual(mapper.flushPending(), [{ event: "reasoning.available", text: "想" }]);
});

test("tool events carry the full input and output, capped", () => {
  const mapper = new ZCodeEventMapper(() => 0);
  const started = mapper.map({
    type: "tool_call",
    toolId: "t1",
    toolName: "Bash",
    kind: "Bash",
    title: "Bash",
    input: { command: "ls -la", description: "list" },
  } as unknown as ZCodeStreamEvent);
  assert.deepEqual(started[0]?.["input"], { command: "ls -la", description: "list" });
  assert.equal(started[0]?.["input_truncated"], undefined);
  const done = mapper.map({
    type: "tool_call_update",
    toolId: "t1",
    status: "completed",
    content: "total 0\n",
  } as unknown as ZCodeStreamEvent);
  assert.equal(done[0]?.["output"], "total 0\n");

  // 输入超 16KB:发截断的 JSON 文本并标记;输出超 32KB:保留头 4KB + 尾 28KB
  const big = mapper.map({
    type: "tool_call",
    toolId: "t2",
    toolName: "Write",
    kind: "Write",
    title: "Write",
    input: { file_path: "a.txt", content: "x".repeat(20_000) },
  } as unknown as ZCodeStreamEvent);
  assert.equal(typeof big[0]?.["input"], "string");
  assert.equal(String(big[0]?.["input"]).length, 16 * 1024);
  assert.equal(big[0]?.["input_truncated"], true);
  assert.equal(big[0]?.["preview"], "a.txt");
  const long = `HEAD${"m".repeat(40_000)}TAIL`;
  const failed = mapper.map({
    type: "tool_call_update",
    toolId: "t2",
    status: "failed",
    content: [{ type: "text", text: long }],
    error: "disk full",
  } as unknown as ZCodeStreamEvent);
  const output = String(failed[0]?.["output"]);
  assert.equal(failed[0]?.["output_truncated"], true);
  assert.equal(failed[0]?.["error"], true);
  assert.ok(output.startsWith("HEAD"));
  assert.ok(output.endsWith("TAIL\ndisk full"));
  assert.match(output, /中间省略 \d+ 字/);
  assert.ok(output.length < 32 * 1024 + 40);
});

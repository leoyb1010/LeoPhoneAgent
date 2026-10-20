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

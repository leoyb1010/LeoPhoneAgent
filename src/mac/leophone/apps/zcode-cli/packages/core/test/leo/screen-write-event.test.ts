// [leo] 禁止代答标记由 core 写进 PermissionRequested 事件（emitPermissionRequested），旧 ask 不带。

import assert from "node:assert/strict";
import test from "node:test";

import { emitPermissionRequested } from "../../src/tool/executor/events.js";

function deps(events: unknown[]) {
  return {
    sessionId: "s1",
    turnId: "t1",
    emitEvent: async (event: unknown) => {
      events.push(event);
    },
  } as never;
}

const toolCall = { id: "tc1", name: "mcp__leo-screen__click", input: {} } as never;
const trace = { traceId: "trace", turnId: "t1" } as never;

test("PermissionRequested 带 autoApproval=forbidden；不带 approval 的 ask 保持旧形状", async () => {
  const events: { payload: Record<string, unknown> }[] = [];
  await emitPermissionRequested(deps(events), toolCall, {}, "r1", "medium", "why", [], trace, {
    autoApproval: "forbidden",
  });
  await emitPermissionRequested(deps(events), toolCall, {}, "r2", "medium", "why", [], trace);
  assert.equal(events[0]?.payload["autoApproval"], "forbidden");
  assert.equal("autoApproval" in (events[1]?.payload ?? {}), false);
});

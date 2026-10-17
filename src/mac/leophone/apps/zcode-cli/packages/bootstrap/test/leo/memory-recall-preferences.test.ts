// [leo][wp-61] 设置「智能体 → 记忆」的两个召回来源开关 → runtimeConfig.memory。
import assert from "node:assert/strict";
import test from "node:test";

import { resolveStartupMemoryRuntimeOverride } from "../../src/zcode-protocol/server-operations.js";

test("记忆总开关只在关闭时写 override", () => {
  assert.deepEqual(resolveStartupMemoryRuntimeOverride({ memoryEnabled: true }), {});
  assert.deepEqual(resolveStartupMemoryRuntimeOverride({ memoryEnabled: false }), {
    memory: { enabled: false },
  });
});

test("语义召回显式写 true/false;藏宝阁召回只写关闭", () => {
  assert.deepEqual(
    resolveStartupMemoryRuntimeOverride({
      memoryEnabled: true,
      memoryRecall: { semantic: true, treasury: true },
    }),
    { memory: { semanticRecall: true } },
  );
  assert.deepEqual(
    resolveStartupMemoryRuntimeOverride({
      memoryEnabled: false,
      memoryRecall: { semantic: false, treasury: false },
    }),
    { memory: { enabled: false, semanticRecall: false, treasuryRecall: false } },
  );
});

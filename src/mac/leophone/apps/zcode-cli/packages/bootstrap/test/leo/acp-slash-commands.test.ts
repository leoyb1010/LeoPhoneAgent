// [leo][WP-21] 外部 agent 会话里的 `/命令` 原样交给 agent：输入门面把本轮模型选择交给命令解析器，
// 解析器见到 ACP 选择就不展开 LeoBot 的内置 / 自定义命令。
import assert from "node:assert/strict";
import test from "node:test";

import { acpModelSelection } from "@zcode/shared/acp";

import { createInputFacade } from "../../src/app/input-facade.js";
import { acpOwnsSlashCommands } from "../../src/app/leo/acp.js";

function facade() {
  const admitted: string[] = [];
  const runtime = {
    getProjectId: () => "p",
    subscribeEvents: () => () => undefined,
    admitPrompt: async (input: string) => {
      admitted.push(input);
      return { kind: "queued" as const };
    },
  };
  const inputFacade = createInputFacade({
    customCommandPromptResolver: async (text, options) =>
      acpOwnsSlashCommands(options?.modelSelection) ? undefined : `EXPANDED(${text})`,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    prepareUserExecutionBoundary: async () => undefined,
    runtime: runtime as never,
    sessionId: "sess" as never,
    traceContext: {} as never,
  });
  return { inputFacade, admitted };
}

test("ACP selection keeps /commands verbatim; LeoBot selection still expands them", async () => {
  const { inputFacade, admitted } = facade();
  await inputFacade.sendInput("/review tests", { intent: { modelSelection: acpModelSelection("claude-code") } } as never);
  await inputFacade.sendInput("/review tests", {
    intent: { modelSelection: { providerId: "openai", modelId: "gpt-5" } },
  } as never);
  assert.deepEqual(admitted, ["/review tests", "EXPANDED(/review tests)"]);
  assert.equal(acpOwnsSlashCommands(undefined), false);
  assert.equal(acpOwnsSlashCommands({ providerId: "acp", modelId: "not-an-agent" }), false);
});

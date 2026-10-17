// [leo] 「全自动」(yolo)与「守护」(guarded,默认档)对 alwaysAsk 工具(工作流创建 / 保存 / 修改)不再询问;
// guarded 对危险命令(userApprovalRule)仍逐次确认;plan 仍然要问。

import assert from "node:assert/strict";
import test from "node:test";

import { PermissionService, defaultPermissionConfig } from "../../src/permission/service.js";

const alwaysAskTool = { alwaysAsk: true, riskLevel: "medium" as const };

function decide(
  mode: "yolo" | "guarded" | "build" | "plan",
  capability: Record<string, unknown>,
  planEnabled = false,
) {
  return new PermissionService(defaultPermissionConfig).checkPermission(
    { toolName: "SaveWorkflow", input: {}, riskLevel: "medium", mode, planEnabled },
    capability,
  ).decision;
}

test("yolo / guarded 放行 alwaysAsk 工具", () => {
  assert.equal(decide("yolo", alwaysAskTool), "allow");
  assert.equal(decide("guarded", alwaysAskTool), "allow");
});

test("build 与 plan 下 alwaysAsk 工具仍然询问", () => {
  assert.equal(decide("build", alwaysAskTool), "ask");
  assert.equal(decide("guarded", alwaysAskTool, true), "ask");
});

test("guarded 对危险命令仍逐次确认", () => {
  assert.equal(
    decide("guarded", { userApprovalRule: "guarded.rm", riskLevel: "high" }),
    "ask",
  );
  assert.equal(decide("yolo", { userApprovalRule: "guarded.rm", riskLevel: "high" }), "allow");
});

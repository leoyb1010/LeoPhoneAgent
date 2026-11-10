// [leo] leo-screen 桌面写操作在所有权限档都要明确审批；观察工具不受影响。
// 契约见 docs/specs/leo-screen-write-approval.md（Mac 工程根）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  isLeoScreenMcpServer,
  isLeoScreenWriteCall,
  LEO_SCREEN_WRITE_APPROVAL_RULE,
} from "../../src/mcp/leo-screen-policy.js";
import { PermissionService, defaultPermissionConfig } from "../../src/permission/service.js";

type Mode = "yolo" | "guarded" | "build" | "edit" | "plan" | "auto";

const CLICK = "mcp__leo-screen__click";
const SEE = "mcp__leo-screen__see";
// 与 createMcpToolEntry 给普通 MCP 工具的元数据一致：needsApproval、network、medium。
const mcpBase = {
  needsApproval: true,
  sideEffectScope: "network" as const,
  riskLevel: "medium" as const,
  permission: { permission: "mcp", needsApproval: true, sideEffectScope: "network" as const },
};
const writeCapability = { ...mcpBase, explicitApprovalRule: LEO_SCREEN_WRITE_APPROVAL_RULE };
const readCapability = { ...mcpBase, readOnly: true, riskLevel: "low" as const };

function decide(
  mode: Mode,
  toolName: string,
  capability: Record<string, unknown>,
  options: {
    planEnabled?: boolean;
    projectRules?: Record<string, unknown>;
    service?: PermissionService;
    disallowed?: string[];
  } = {},
) {
  const service =
    options.service ??
    new PermissionService({
      ...defaultPermissionConfig,
      disallowedTools: new Set(options.disallowed ?? []),
    });
  return service.checkPermission(
    {
      toolName,
      input: {},
      riskLevel: "medium",
      mode,
      planEnabled: options.planEnabled ?? mode === "plan",
    },
    capability,
    (options.projectRules ?? null) as never,
  );
}

test("分类按真实 toolName 与 action：观察放行、写操作和未知一律审批", () => {
  for (const name of ["see", "image", "inspect_ui", "permissions", "sleep", "verify_state", "SEE"]) {
    assert.equal(isLeoScreenWriteCall(name, {}), false, name);
  }
  for (const name of ["click", "type", "press", "hotkey", "scroll", "drag", "set_value", "action", "dialog", "brand_new_tool"]) {
    assert.equal(isLeoScreenWriteCall(name, {}), true, name);
  }
  assert.equal(isLeoScreenWriteCall("app", { action: "list" }), false);
  assert.equal(isLeoScreenWriteCall("window", { action: " LIST " }), false);
  assert.equal(isLeoScreenWriteCall("app", { action: "launch" }), true);
  assert.equal(isLeoScreenWriteCall("app", { action: "quit" }), true);
  assert.equal(isLeoScreenWriteCall("app", {}), true);
  assert.equal(isLeoScreenWriteCall("app", { action: 1 }), true);
  assert.equal(isLeoScreenWriteCall("window", { action: "focus" }), true);
  assert.equal(isLeoScreenWriteCall("clipboard", { action: "get" }), false);
  assert.equal(isLeoScreenWriteCall("clipboard", { action: "get", outputPath: "/tmp/a.png" }), true);
  assert.equal(isLeoScreenWriteCall("clipboard", { action: "get", outputPath: null }), false);
  assert.equal(isLeoScreenWriteCall("clipboard", { action: "save" }), true);
  assert.equal(isLeoScreenWriteCall("clipboard", { action: "set" }), true);
  assert.equal(isLeoScreenMcpServer(" Leo-Screen "), true);
  assert.equal(isLeoScreenMcpServer("leo-screen-clone"), false);
});

test("写操作在 guarded（默认）/ yolo / build / edit 都要审批", () => {
  for (const mode of ["guarded", "yolo", "build", "edit"] as const) {
    const result = decide(mode, CLICK, writeCapability);
    assert.equal(result.decision, "ask", mode);
    assert.equal(result.ruleId, LEO_SCREEN_WRITE_APPROVAL_RULE, mode);
    assert.equal(result.alwaysAsk, true, mode);
    assert.equal(result.autoApproval, "forbidden", mode);
  }
});

test("观察工具保持原模式语义，不增加摩擦", () => {
  assert.equal(decide("guarded", SEE, readCapability).decision, "allow");
  assert.equal(decide("yolo", SEE, readCapability).decision, "allow");
  assert.equal(decide("build", SEE, { ...readCapability, needsApproval: false }).decision, "allow");
});

test("Plan、auto、硬禁用、项目 deny 都直接拒绝写操作", () => {
  assert.equal(decide("guarded", CLICK, writeCapability, { planEnabled: true }).decision, "deny");
  assert.equal(decide("plan", CLICK, writeCapability).decision, "deny");
  assert.equal(decide("auto", CLICK, writeCapability).decision, "deny");
  assert.equal(decide("yolo", CLICK, writeCapability, { disallowed: [CLICK] }).decision, "deny");
  const denied = decide("yolo", CLICK, writeCapability, {
    projectRules: { version: 1, deny: [{ toolName: CLICK }], allow: [{ toolName: CLICK }] },
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.ruleId, "rule.project.deny");
});

test("只有精确针对该工具的项目 / 会话授权才放行", () => {
  const project = decide("guarded", CLICK, writeCapability, {
    projectRules: { version: 1, allow: [{ toolName: CLICK }] },
  });
  assert.equal(project.decision, "allow");
  assert.equal(project.ruleId, "rule.project.allow");

  const other = decide("guarded", CLICK, writeCapability, {
    projectRules: { version: 1, allow: [{ toolName: "mcp__leo-screen__type" }, { toolName: "Bash" }] },
  });
  assert.equal(other.decision, "ask");

  const service = new PermissionService(defaultPermissionConfig);
  service.grantSessionPermission([
    { type: "addRules", behavior: "allow", rules: [{ toolName: CLICK }] },
  ]);
  assert.equal(decide("yolo", CLICK, writeCapability, { service }).decision, "allow");
  assert.equal(
    decide("yolo", "mcp__leo-screen__type", writeCapability, { service }).decision,
    "ask",
  );
});

test("没有 explicitApprovalRule 的同名第三方工具不受影响", () => {
  assert.equal(decide("guarded", "mcp__other__click", mcpBase).decision, "allow");
  assert.equal(decide("build", "mcp__other__click", mcpBase).decision, "ask");
});

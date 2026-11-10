// [leo] MCP 桥只给真实 serverName 为 leo-screen 的条目挂写操作审批，并按本次入参的 action 判定。
// 契约见 docs/specs/leo-screen-write-approval.md（Mac 工程根）。

import assert from "node:assert/strict";
import test from "node:test";

import type { McpPort, McpToolDescriptor } from "@zcode/contracts";

import { createMcpToolEntry } from "../../src/mcp/index.js";
import { LEO_SCREEN_WRITE_APPROVAL_RULE } from "../../src/mcp/leo-screen-policy.js";
import { PermissionService, defaultPermissionConfig } from "../../src/permission/service.js";
import { resolveRuntimePermissionCapability } from "../../src/tool/executor/permission-capability.js";

const port = { callTool: async () => ({ content: [] }) } as unknown as McpPort;

function entry(serverName: string, toolName: string, annotations?: McpToolDescriptor["annotations"]) {
  const descriptor = { serverName, toolName, annotations } as McpToolDescriptor;
  return createMcpToolEntry(`mcp__${serverName}__${toolName}`, descriptor, port, false);
}

function decide(serverName: string, toolName: string, input: unknown, mode: "guarded" | "yolo") {
  const tool = entry(serverName, toolName);
  return new PermissionService(defaultPermissionConfig).checkPermission(
    { toolName: tool.metadata.name, input, riskLevel: tool.metadata.riskLevel, mode },
    resolveRuntimePermissionCapability(tool, input, {}),
  );
}

test("leo-screen 写操作经真实 MCP 条目在默认守护档与全自动档都要审批", () => {
  for (const mode of ["guarded", "yolo"] as const) {
    const click = decide("leo-screen", "click", { on: "B1" }, mode);
    assert.equal(click.decision, "ask", mode);
    assert.equal(click.ruleId, LEO_SCREEN_WRITE_APPROVAL_RULE);
    assert.equal(decide("leo-screen", "app", { action: "launch", name: "Mail" }, mode).decision, "ask");
    assert.equal(decide("leo-screen", "see", {}, mode).decision, "allow");
    assert.equal(decide("leo-screen", "app", { action: "list" }, mode).decision, "allow");
  }
});

test("readOnly annotation 不能让 leo-screen 写工具绕过审批", () => {
  const tool = entry("leo-screen", "click", { readOnlyHint: true });
  const capability = resolveRuntimePermissionCapability(tool, {}, {});
  assert.equal(capability.explicitApprovalRule, LEO_SCREEN_WRITE_APPROVAL_RULE);
});

test("其他 MCP 服务的同名工具不挂这条规则", () => {
  const tool = entry("my-tools", "click");
  assert.equal(tool.resolvePermissionCapability, undefined);
  assert.equal(decide("my-tools", "click", {}, "guarded").decision, "allow");
});

test("clipboard get 只在不带 outputPath 时免审批（Peekaboo v4.9.4 get + outputPath 会写文件）", () => {
  for (const mode of ["guarded", "yolo"] as const) {
    assert.equal(decide("leo-screen", "clipboard", { action: "get" }, mode).decision, "allow");
    const withPath = decide("leo-screen", "clipboard", { action: "get", outputPath: "/tmp/clip.png" }, mode);
    assert.equal(withPath.decision, "ask", mode);
    assert.equal(withPath.ruleId, LEO_SCREEN_WRITE_APPROVAL_RULE);
    assert.equal(decide("leo-screen", "clipboard", { action: "get", outputPath: "" }, mode).decision, "ask");
    assert.equal(decide("leo-screen", "clipboard", { action: "save", path: "/tmp/x" }, mode).decision, "ask");
  }
});

test("写操作的判定带结构化禁止代答标记，观察工具不带", () => {
  const click = decide("leo-screen", "click", {}, "yolo");
  assert.equal(click.autoApproval, "forbidden");
  assert.equal(decide("leo-screen", "see", {}, "yolo").autoApproval, undefined);
  assert.equal(decide("my-tools", "click", {}, "yolo").autoApproval, undefined);
});

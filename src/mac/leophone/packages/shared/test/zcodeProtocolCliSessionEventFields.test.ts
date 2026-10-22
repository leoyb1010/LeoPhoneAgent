import { describe, expect, it } from "vitest";

import { zcodeSessionEventSchema } from "../src/zcode-protocol/index.js";

// [up3-runtime] 这些载荷照 CLI 内核真实发出的形状写(apps/zcode-cli 的 core/runtime/methods/turn.ts、
// core/tool/executor/events.ts、core/mcp/index.ts、core/subagent/tool-event-mirror.ts,再经
// bootstrap/zcode-protocol/session-mapper.ts 映射)。桌面的 strict schema 漏声明任何一个字段,
// zcodeAgentService 都会 safeParse 失败并「丢弃无效 ZCode Protocol session event」整条事件。
function envelope(type: string, payload: Record<string, unknown>) {
  return {
    eventId: "evt_1",
    seq: 7,
    sessionId: "sess_1",
    turnId: "turn_1",
    traceId: "trace_1",
    timestamp: 1_789_614_547_807,
    deliveryKind: "desktop-continuous",
    type,
    payload,
  };
}

function expectAccepted(type: string, payload: Record<string, unknown>) {
  const parsed = zcodeSessionEventSchema.safeParse(envelope(type, payload));
  expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  return parsed.success ? (parsed.data.payload as Record<string, unknown>) : undefined;
}

describe("CLI session event fields on the desktop schema", () => {
  it("accepts turn.started dispatched by an automation", () => {
    const payload = expectAccepted("turn.started", {
      executionStartedAt: 1_789_614_547_807.25,
      turnNumber: 3,
      input: "每日汇总",
      messageId: "msg_1",
      inputId: "automation-daily_1:run_2",
      automationId: "automation-daily_1",
      foregroundExecutionId: "fg_1",
      queryId: "query_1",
      inputSource: "background_task",
      inputVisibility: "model-only",
      targetId: "target_1",
      intent: { sourceCommandId: "cmd_1", kind: "sendText" },
    });
    expect(payload).toMatchObject({ automationId: "automation-daily_1" });
  });

  it("accepts off-peak attribution, epilogue and workflow background source on turn.started", () => {
    const payload = expectAccepted("turn.started", {
      turnNumber: 4,
      input: "继续\n\n[engine note]",
      offPeakTaskId: "offpeak_1",
      offPeakRunType: "resume",
      epilogueStart: 3,
      backgroundSource: "workflow",
      originMeta: { backgroundSource: "workflow", workId: "run_1", title: "研究" },
    });
    expect(payload).toMatchObject({ offPeakRunType: "resume", epilogueStart: 3 });
  });

  it("accepts the controlOnly workflow launch turn.started", () => {
    const payload = expectAccepted("turn.started", {
      turnNumber: 1,
      input: "运行 研究工作流",
      messageId: "msg_launch",
      executionKind: "controlOnly",
      inputSource: "workflow_launch",
      workflowLaunch: {
        runId: "run_1",
        toolCallId: "launch-1",
        name: "研究工作流",
        scope: "project",
        path: "/tmp/project/.zcode/workflows/research.ts",
        args: { topic: "MCP" },
        description: "调研一个主题",
      },
    });
    expect(payload?.["workflowLaunch"]).toMatchObject({ runId: "run_1", toolCallId: "launch-1" });
  });

  it("still rejects an off-vocabulary offPeakRunType", () => {
    const parsed = zcodeSessionEventSchema.safeParse(
      envelope("turn.started", { turnNumber: 1, input: "x", offPeakRunType: "later" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts tool.updated scheduled with an MCP display", () => {
    expectAccepted("tool.updated", {
      kind: "scheduled",
      toolCallId: "call_1",
      assistantMessageId: "msg_a",
      toolName: "mcp__leo-treasury__treasury_search",
      input: { query: "护照" },
      dependencies: [],
      parallelGroupIndex: 0,
      canRunParallel: true,
      display: { kind: "mcp", serverName: "leo-treasury", title: "藏宝阁" },
      schedule: { parallelGroups: [["call_1"]], executionOrder: ["call_1"] },
    });
  });

  it("accepts tool.updated started with display, readOnly and sideEffectScope", () => {
    const payload = expectAccepted("tool.updated", {
      kind: "started",
      toolCallId: "call_2",
      toolName: "Bash",
      startedAt: 1_789_614_547_900,
      display: { kind: "mcp", serverName: "leo-treasury" },
      readOnly: true,
      sideEffectScope: "none",
    });
    expect(payload).toMatchObject({ readOnly: true, sideEffectScope: "none" });
  });

  it("accepts a subagent-mirrored tool.updated started with capability fields", () => {
    expectAccepted("tool.updated", {
      kind: "started",
      toolCallId: "subagent_agent1_call_3",
      toolName: "Write",
      startedAt: 1_789_614_547_901,
      readOnly: false,
      sideEffectScope: "workspace",
      agentId: "agent1",
      agentType: "general",
      background: true,
      childSessionId: "sess_child",
      childToolCallId: "call_3",
      description: "写文件",
      parentToolCallId: "call_parent",
      source: "subagent",
    });
  });

  it("rejects an unknown sideEffectScope and a malformed display", () => {
    expect(
      zcodeSessionEventSchema.safeParse(
        envelope("tool.updated", {
          kind: "started",
          toolCallId: "call_2",
          startedAt: 1,
          sideEffectScope: "everything",
        }),
      ).success,
    ).toBe(false);
    expect(
      zcodeSessionEventSchema.safeParse(
        envelope("tool.updated", {
          kind: "started",
          toolCallId: "call_2",
          startedAt: 1,
          display: { kind: "node_repl_images", images: [] },
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts tool.updated progress forwarded from MCP notifications/progress", () => {
    expectAccepted("tool.updated", {
      kind: "progress",
      toolCallId: "call_4",
      toolName: "mcp__x__long_job",
      elapsedMs: 1200,
      progress: 3,
      total: 10,
      message: "indexing",
    });
  });

  it("accepts tool.updated result / error carrying skillMetadata", () => {
    expectAccepted("tool.updated", {
      kind: "result",
      toolCallId: "call_5",
      skillMetadata: { qualifiedName: "plugin:skill", pluginId: "plugin", source: "plugin" },
      result: { success: true, content: "ok", truncated: false },
      duration: 12,
    });
    expectAccepted("tool.updated", {
      kind: "error",
      toolCallId: "call_6",
      skillMetadata: { qualifiedName: "skill", source: "bundled" },
      error: { type: "ToolError", message: "boom" },
    });
  });

  it("accepts permission.requested with fullAccessSupported, display and optionsPolicy", () => {
    const payload = expectAccepted("permission.requested", {
      requestId: "req_1",
      toolCallId: "call_7",
      toolName: "Bash",
      riskLevel: "medium",
      reason: "Tool Bash requires approval",
      input: { command: "rm -rf build" },
      suggestedPermissionUpdates: [],
      fullAccessSupported: true,
      optionsPolicy: "session-always-allow",
      display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
      options: [
        {
          optionId: "allow_once",
          kind: "allow_once",
          name: "Allow once",
          response: { decision: "allow" },
        },
        { optionId: "deny", kind: "reject_once", name: "Deny", response: { decision: "deny" } },
      ],
    });
    expect(payload).toMatchObject({ fullAccessSupported: true });
  });
});

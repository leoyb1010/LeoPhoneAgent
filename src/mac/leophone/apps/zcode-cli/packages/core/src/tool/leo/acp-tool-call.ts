// [leo][WP-21] AcpToolCall：ACP 外部 agent（Claude Code / Codex / Gemini / opencode）的一步操作。
// agent 自己执行文件与命令；这里只负责把它交给 LeoBot 的权限档与审批卡，批准后回复 agent 并等这步跑完。
//   - agent 没要授权（needsApproval=false）：只读通行，不弹窗；
//   - 要授权：yolo 直接批准；guarded 只对删除与危险命令逐次确认（同 Bash 的 userApprovalRule）；
//     其它档位走普通审批。被拒绝时 handler 不运行，ACP 模型在下一次请求里把拒绝回给 agent。
import type { ExecutionShellSelection } from "@zcode/contracts";
import type { AcpToolCallInput, AcpToolCallOutput } from "@zcode/shared/acp";
import { ACP_TOOL_NAME } from "@zcode/shared/acp";
import { matchDangerousCommand } from "../handlers/guarded/command.js";
import type {
  ToolEntry,
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";

export interface AcpToolPort {
  /** 回复 agent 的授权请求（若有）并等这一步结束。 */
  runApprovedTool(input: {
    sessionId: string;
    leoToolCallId: string;
    acpToolCallId: string;
    allowAlways: boolean;
    signal: AbortSignal;
  }): Promise<AcpToolCallOutput>;
}

const TIMEOUT_MS = 30 * 60_000;
const OUTPUT_BYTES = 256 * 1024;
const GUARDED_DIALECT: ExecutionShellSelection["dialect"] = "posix";

function readInput(input: unknown): AcpToolCallInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Partial<AcpToolCallInput>;
  return typeof value.acpToolCallId === "string" && typeof value.kind === "string"
    ? (value as AcpToolCallInput)
    : undefined;
}

export function resolveAcpToolPermissionCapability(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const parsed = readInput(input);
  if (!parsed) return undefined;
  if (!parsed.needsApproval) {
    // agent 已自行放行（在它自己的模式里不需要问）：这一步已经在跑，LeoBot 只展示。
    return {
      destructive: false,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
      permission: { needsApproval: false, riskLevel: "low", sideEffectScope: "none" },
    };
  }
  if (context?.mode === "guarded") {
    if (parsed.kind === "delete") return { userApprovalRule: "safety.acp.delete", destructive: true };
    if (parsed.command) {
      const match = matchDangerousCommand(parsed.command, GUARDED_DIALECT);
      if (match.status === "matched") return { userApprovalRule: match.ruleId };
    }
  }
  const readOnlyKind = ["read", "search", "fetch", "think"].includes(parsed.kind);
  return {
    destructive: parsed.kind === "delete",
    needsApproval: true,
    readOnly: false,
    riskLevel: parsed.kind === "delete" ? "high" : readOnlyKind ? "low" : "medium",
    sideEffectScope: parsed.kind === "fetch" ? "network" : readOnlyKind ? "none" : "workspace",
  };
}

function formatOutput(output: AcpToolCallOutput): string {
  const lines = [`${output.title} — ${output.status}`];
  if (output.text) lines.push(output.text);
  for (const diff of output.diffs ?? []) lines.push(`(diff) ${diff.path}`);
  return lines.join("\n");
}

export function createAcpToolCallEntry(port: AcpToolPort): ToolEntry {
  return {
    capability: "Approve and observe one step of an external ACP agent",
    metadata: {
      name: ACP_TOOL_NAME,
      description:
        "One step taken by an external coding agent (Claude Code, Codex, Gemini, opencode) in this session. Emitted by the agent itself; never call it directly.",
      readOnly: false,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: OUTPUT_BYTES,
      sideEffectScope: "workspace",
      riskLevel: "medium",
      needsApproval: true,
      // 只由 ACP 模型发出，不进任何模型的工具清单。
      providerVisible: false,
    },
    handler: async (input, context) => {
      const parsed = readInput(input);
      if (!parsed) throw new Error("AcpToolCall input is invalid");
      return port.runApprovedTool({
        sessionId: String(context.sessionId),
        leoToolCallId: String(context.toolCallId),
        acpToolCallId: parsed.acpToolCallId,
        allowAlways: false,
        signal: context.abortSignal,
      });
    },
    formatModelContent: (output) => formatOutput(output as AcpToolCallOutput),
    resolvePermissionCapability: resolveAcpToolPermissionCapability,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["agentId", "acpToolCallId", "leoToolCallId", "title", "kind", "needsApproval"],
      properties: {
        agentId: { type: "string" },
        acpToolCallId: { type: "string" },
        leoToolCallId: { type: "string" },
        title: { type: "string" },
        kind: { type: "string" },
        needsApproval: { type: "boolean" },
        command: { type: "string" },
        path: { type: "string" },
        diff: { type: "object" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["status", "title", "kind", "text"],
      properties: {
        status: { type: "string", enum: ["completed", "failed", "cancelled"] },
        title: { type: "string" },
        kind: { type: "string" },
        text: { type: "string" },
        diffs: { type: "array", items: { type: "object" } },
      },
    },
    permission: {
      permission: "acp.tool",
      reason: "An external agent asks to run this step",
      riskLevel: "medium",
      sideEffectScope: "workspace",
      needsApproval: true,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: OUTPUT_BYTES,
      maxModelBytes: OUTPUT_BYTES,
      strategy: "truncate",
      preview: { maxBytes: 8 * 1024, direction: "head" },
    },
    timeout: { defaultMs: TIMEOUT_MS, maxMs: TIMEOUT_MS, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "The external agent step was cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

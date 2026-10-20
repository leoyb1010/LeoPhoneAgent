// [leo][WP-21] ACP 工具调用的状态与翻译（交给运行时的 AcpToolCallInput、回给运行时的 AcpToolCallOutput）。
// 从 session.ts 拆出（单文件 400 行上限）。
import type {
  ContentBlock,
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import type { AcpAgentId, AcpToolCallInput, AcpToolCallOutput } from "@zcode/shared/acp";

/** 单个 diff（old+new）超过这么大就只给摘要：整份塞进工具卡 / 回执会把手机和日志撑爆。 */
export const ACP_DIFF_LIMIT_BYTES = 256 * 1024;

export interface ToolState {
  id: string;
  title: string;
  kind: string;
  status: string;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput: unknown;
  rawOutput: unknown;
  announced: boolean;
  permission?: {
    options: PermissionOption[];
    resolve: (response: RequestPermissionResponse) => void;
    /** 以哪个 LeoBot 工具调用 id 交给了运行时（同一 ACP 调用在竞态下可能再交一次）。 */
    announcedAs?: string;
  };
  waiters: Array<() => void>;
}

export function contentText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.uri;
    case "resource":
      return "text" in content.resource ? content.resource.text : "";
    default:
      return "";
  }
}

function firstLocationPath(tool: ToolState): string | undefined {
  return tool.locations[0]?.path;
}

function rawString(raw: unknown, ...keys: string[]): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return (value as string[]).join(" ");
    }
  }
  return undefined;
}

export function toToolInput(
  agentId: AcpAgentId,
  tool: ToolState,
  needsApproval: boolean,
  leoToolCallId: string,
): AcpToolCallInput {
  const diffContent = tool.content.find((item) => item.type === "diff");
  const command = tool.kind === "execute" ? rawString(tool.rawInput, "command", "cmd") : undefined;
  const path =
    firstLocationPath(tool) ??
    (diffContent && diffContent.type === "diff" ? diffContent.path : undefined) ??
    rawString(tool.rawInput, "file_path", "path", "abs_path");
  return {
    agentId,
    acpToolCallId: tool.id,
    leoToolCallId,
    title: tool.title,
    kind: tool.kind,
    needsApproval,
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(diffContent && diffContent.type === "diff"
      ? { diff: capDiff(diffContent.path, diffContent.oldText ?? null, diffContent.newText) }
      : {}),
  };
}

export function summarizeTool(tool: ToolState): AcpToolCallOutput {
  const texts: string[] = [];
  const diffs: NonNullable<AcpToolCallOutput["diffs"]> = [];
  for (const item of tool.content) {
    if (item.type === "content") {
      const text = contentText(item.content);
      if (text) texts.push(text);
    } else if (item.type === "diff") {
      diffs.push(capDiff(item.path, item.oldText ?? null, item.newText));
    } else if (item.type === "terminal") {
      texts.push(`[terminal ${item.terminalId}]`);
    }
  }
  if (texts.length === 0 && typeof tool.rawOutput === "string") texts.push(tool.rawOutput);
  if (texts.length === 0 && tool.rawOutput && typeof tool.rawOutput === "object") {
    const output = rawString(tool.rawOutput, "output", "stdout", "result", "content");
    if (output) texts.push(output);
  }
  const status = tool.status === "failed" ? "failed" : tool.status === "completed" ? "completed" : "cancelled";
  return {
    status,
    title: tool.title,
    kind: tool.kind,
    text: texts.join("\n").slice(0, 64 * 1024),
    ...(diffs.length > 0 ? { diffs } : {}),
  };
}

/** diff 超过 ACP_DIFF_LIMIT_BYTES 时只给摘要（大文件整份重写、生成的锁文件之类）。 */
export function capDiff(
  path: string,
  oldText: string | null,
  newText: string,
): { path: string; oldText: string | null; newText: string } {
  const bytes = Buffer.byteLength(oldText ?? "") + Buffer.byteLength(newText);
  if (bytes <= ACP_DIFF_LIMIT_BYTES) return { path, oldText, newText };
  const lines = (text: string | null) => (text ? text.split("\n").length : 0);
  return {
    path,
    oldText: null,
    newText: `（改动过大，约 ${Math.round(bytes / 1024)} KB：原 ${lines(oldText)} 行 → 新 ${lines(newText)} 行，未附完整内容）`,
  };
}

export function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}

export function pickOption(
  options: readonly PermissionOption[],
  kind: PermissionOption["kind"],
): PermissionOption | undefined {
  return options.find((option) => option.kind === kind);
}

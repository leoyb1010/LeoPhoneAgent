// [leo][WP-21] 外部 agent（Claude Code / Codex / Gemini / opencode）的一步操作：AcpToolCall。
// 编辑类直接给内联 diff（同 Edit 卡的轻量高亮），命令类给命令与输出，其余给标题与结果文字。
import {
  BrainIcon,
  FilePenIcon,
  FileSearchIcon,
  GlobeIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";
import {
  acpAgentInfo,
  isAcpAgentId,
  type AcpToolCallInput,
  type AcpToolCallOutput,
} from "@zcode/shared/acp";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { EditInlineDiffContent } from "@/ToolCallBlocks/renderers/EditInlineDiffContent.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const ICON_CLASS = "size-4 shrink-0 text-foreground-subtle";

function kindIcon(kind: string): ReactNode {
  switch (kind) {
    case "edit":
    case "move":
      return <FilePenIcon className={ICON_CLASS} />;
    case "delete":
      return <Trash2Icon className={ICON_CLASS} />;
    case "execute":
      return <SquareTerminalIcon className={ICON_CLASS} />;
    case "read":
    case "search":
      return <FileSearchIcon className={ICON_CLASS} />;
    case "fetch":
      return <GlobeIcon className={ICON_CLASS} />;
    case "think":
      return <BrainIcon className={ICON_CLASS} />;
    default:
      return <WrenchIcon className={ICON_CLASS} />;
  }
}

const KIND_LABEL_IDS: Record<string, string> = {
  edit: "chat.toolCall.kind.edit",
  move: "chat.toolCall.kind.edit",
  delete: "chat.toolCall.kind.delete",
  execute: "chat.toolCall.kind.terminal",
  read: "chat.toolCall.kind.read",
  search: "chat.toolCall.kind.search",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readAcpToolInput(value: unknown): AcpToolCallInput | undefined {
  const record = asRecord(value);
  return record && typeof record.acpToolCallId === "string" && typeof record.kind === "string"
    ? (record as unknown as AcpToolCallInput)
    : undefined;
}

function readAcpToolOutput(value: unknown): AcpToolCallOutput | undefined {
  const record = asRecord(value);
  return record && typeof record.status === "string" ? (record as unknown as AcpToolCallOutput) : undefined;
}

/** 由前后两段文本拼一个单 hunk 的统一 diff：去掉首尾相同的行，中间整体替换。 */
export function buildAcpUnifiedPatch(path: string, oldText: string | null | undefined, newText: string): string {
  const before = oldText ? oldText.split("\n") : [];
  const after = newText.split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const context = 2;
  const start = Math.max(0, head - context);
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  const leading = before.slice(start, head);
  const trailing = before.slice(before.length - tail, Math.min(before.length, before.length - tail + context));
  const oldCount = leading.length + removed.length + trailing.length;
  const newCount = leading.length + added.length + trailing.length;
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldCount === 0 ? 0 : start + 1},${oldCount} +${newCount === 0 ? 0 : start + 1},${newCount} @@`,
    ...leading.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...trailing.map((line) => ` ${line}`),
  ];
  return lines.join("\n");
}

export function AcpToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = readAcpToolInput(toolCall.input);
  const output = readAcpToolOutput(toolCall.output);
  const kind = input?.kind ?? output?.kind ?? "other";
  const agentName = input && isAcpAgentId(input.agentId) ? acpAgentInfo(input.agentId).name : "Agent";
  const kindLabelId = KIND_LABEL_IDS[kind];
  const kindLabel = kindLabelId ? `${agentName} · ${intl.formatMessage({ id: kindLabelId })}` : agentName;
  const title = output?.title ?? input?.title ?? toolCall.title ?? "AcpToolCall";
  const diffs = useMemo(() => {
    const list = output?.diffs ?? (input?.diff ? [input.diff] : []);
    return list.map((diff) => ({
      type: "patch" as const,
      title: diff.path,
      path: diff.path,
      patch: buildAcpUnifiedPatch(diff.path, diff.oldText, diff.newText),
    }));
  }, [input?.diff, output?.diffs]);
  const command = input?.command;
  const resultText = output?.text?.trim() || (toolCall.status === "failed" ? context.errorText : undefined);
  const isFailed = toolCall.status === "failed" || output?.status === "failed";
  const isDenied = toolCall.status === "denied";
  const hasDetails = diffs.length > 0 || Boolean(command) || Boolean(resultText);

  const primaryText = useMemo(
    () => <span className="min-w-0 truncate">{command ?? input?.path ?? title}</span>,
    [command, input?.path, title],
  );
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {diffs.map((preview) => (
          <EditInlineDiffContent
            key={preview.path}
            preview={preview}
            {...(context.theme ? { theme: context.theme } : {})}
            {...(context.codePreviewSettings ? { codePreviewSettings: context.codePreviewSettings } : {})}
          />
        ))}
        {command ? (
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-panel px-3 py-2 font-mono text-ui-sm text-foreground">
            {`$ ${command}`}
          </pre>
        ) : null}
        {resultText ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
            {resultText}
          </pre>
        ) : null}
      </div>
    ),
    [command, context.codePreviewSettings, context.theme, diffs, resultText],
  );

  const statusLabelId = isFailed
    ? "chat.toolCall.status.failed"
    : isDenied
      ? "chat.toolCall.status.denied"
      : undefined;
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={kindIcon(kind)}
      showIcon={context.showIcon !== false}
      canToggle={hasDetails && (context.canToggle ?? true)}
      forceOpen={hasDetails && (context.forceOpen ?? false)}
      kindLabel={kindLabel}
      sourceLabel={context.sourceLabel}
      primaryText={primaryText}
      statusLabel={statusLabelId ? intl.formatMessage({ id: statusLabelId }) : undefined}
      showStatusLabel={statusLabelId != null}
      showFailureStatus={isFailed}
      isRunning={context.isRunning}
      title={title}
      renderContent={hasDetails ? renderContent : undefined}
    />
  );
}

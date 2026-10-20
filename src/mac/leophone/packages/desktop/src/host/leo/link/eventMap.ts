import type { ZCodePermissionRequest, ZCodeStreamEvent, ZCodeUsage } from "@zcode/shared";

import type { HarnessEvent } from "./journal.js";

/**
 * [leo-link] ZCode 流事件 → 手机协议 v0.4 事件(还没编号,编号由会话统一加)。
 *
 * 手机端(iOS `GatewayEvent.parse`、Android `MinisHarnessRouter`)只认 v0.4 的词汇,
 * 所以这里是唯一的翻译点。审批、提问、审批回执带副作用,由会话自己处理,不经过这里。
 */
/** 正文增量合并窗口:窗口内的 token 合成一条 message.delta(一行日志、一帧)。 */
export const DELTA_MERGE_MS = 50;

export class ZCodeEventMapper {
  private thought = "";
  /** 还没发出去的正文增量;定时器到点或下一条别的事件到来时整段发。 */
  private text = "";
  private textTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tools = new Map<string, { name: string; startedAt: number }>();

  /**
   * onDeferred:合并窗口到点时把攒着的正文交回会话编号发出。
   * [fix] 以前每个 token 一条 message.delta,一条日志一帧,长回答在手机和日志里都是成千上万行。
   * 合并只改帧的粒度,不改语义:手机按 seq 续传、按顺序拼接 delta,和以前一样。
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly onDeferred?: (events: HarnessEvent[]) => void,
    private readonly mergeMs = DELTA_MERGE_MS,
  ) {}

  map(event: ZCodeStreamEvent): HarnessEvent[] {
    if (event.type === "agent_thought_chunk") {
      if (!isMainAgent(event.parentToolUseId)) return [];
      const out = this.takeText();
      this.thought += event.content;
      return out;
    }
    if (event.type === "agent_message_chunk") {
      // 思考整段发一次:iOS 每条 reasoning 都单独成行,逐 token 发会刷出几百行。
      const out = this.flushThought();
      // 子 agent 的正文和上下文压缩这类合成横条不进手机对话。
      if (isMainAgent(event.parentToolUseId) && !event.zcodeTimeline && event.content) {
        this.text += event.content;
        this.scheduleText();
      }
      return out;
    }
    const out = this.flushPending();
    switch (event.type) {
      case "tool_call": {
        if (!isMainAgent(event.parentToolUseId)) break;
        const name = event.toolName || event.kind || "tool";
        this.tools.set(event.toolId, { name, startedAt: this.now() });
        out.push({
          event: "tool.started",
          tool: name,
          tool_use_id: event.toolId,
          preview: toolPreview(event.input, event.title),
        });
        break;
      }
      case "tool_call_update": {
        if (!FINISHED_TOOL_STATUSES.has(event.status)) break;
        const started = this.tools.get(event.toolId);
        // 没见过开头的(子 agent 的、订阅之前开始的)不发:手机上没有对应的"运行中"行可以闭合。
        if (!started) break;
        this.tools.delete(event.toolId);
        out.push({
          event: "tool.completed",
          tool: started.name,
          tool_use_id: event.toolId,
          duration: Math.max(0, (this.now() - started.startedAt) / 1000),
          error: event.status !== "completed",
        });
        break;
      }
      case "task_complete":
        this.tools.clear();
        out.push(terminalEvent(event.stopReason, event.usage));
        break;
      case "task_error":
        this.tools.clear();
        // [fix-remote] 带上失败类别：外部 agent 未登录（acp_auth）时手机直接给「去登录」。
        out.push({ event: "run.failed", error: event.error || "任务出错", ...(event.code ? { code: event.code } : {}) });
        break;
      default:
        break;
    }
    return out;
  }

  /** 审批、提问以及会话自己发的任何事件之前,先把攒着的正文 / 思考发出去,顺序才对(两者同一时刻至多一个非空)。 */
  flushPending(): HarnessEvent[] {
    return [...this.takeText(), ...this.flushThought()];
  }

  private flushThought(): HarnessEvent[] {
    const text = this.thought.trim();
    this.thought = "";
    return text ? [{ event: "reasoning.available", text }] : [];
  }

  private takeText(): HarnessEvent[] {
    if (this.textTimer) clearTimeout(this.textTimer);
    this.textTimer = null;
    const delta = this.text;
    this.text = "";
    return delta ? [{ event: "message.delta", delta }] : [];
  }

  private scheduleText(): void {
    // 没有回调(只做翻译)就不攒,立刻由下一次 flushPending 取走。
    if (!this.onDeferred || this.textTimer) return;
    this.textTimer = setTimeout(() => {
      this.textTimer = null;
      const events = this.takeText();
      if (events.length) this.onDeferred?.(events);
    }, this.mergeMs);
    this.textTimer.unref?.();
  }
}

const FINISHED_TOOL_STATUSES = new Set(["completed", "failed", "denied", "stopped"]);

function isMainAgent(parentToolUseId: string | null | undefined): boolean {
  return parentToolUseId == null || parentToolUseId === "";
}

/** 终态看流内 stopReason:用户中断是 cancelled,不能记成完成。 */
export function terminalEvent(stopReason: string, usage?: ZCodeUsage): HarnessEvent {
  if (stopReason === "cancelled") return { event: "run.cancelled" };
  if (stopReason.startsWith("error")) return { event: "run.failed", error: stopReason };
  return {
    event: "run.completed",
    ...(usage
      ? {
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          },
        }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 工具输入里最能说明"它要干什么"的一项:命令、路径、网址、搜索词。 */
export function toolTarget(input: unknown): string {
  const obj = record(input);
  for (const key of ["command", "file_path", "path", "notebook_path", "url", "pattern", "query"]) {
    const value = text(obj[key]);
    if (value) return value;
  }
  return "";
}

function toolPreview(input: unknown, title: string | undefined): string {
  return (toolTarget(input) || text(title)).slice(0, 200);
}

/** 审批卡上显示的内容:工具名 + 它要执行的命令或要动的文件。 */
export function describePermission(request: ZCodePermissionRequest): {
  tool: string;
  target: string;
  command: string;
  description: string;
} {
  const raw = record(request.raw);
  const tool = text(raw["toolName"]) || text(request.kind) || text(request.title) || "tool";
  const target = toolTarget(raw["input"]);
  const reason = text(raw["reason"]) || text(request.description);
  return {
    tool,
    target,
    command: (target ? `${tool}: ${target}` : reason || tool).slice(0, 500),
    description: reason.slice(0, 500),
  };
}

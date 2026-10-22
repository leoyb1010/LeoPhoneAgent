import type {
  ZCodeAutomation,
  ZCodeAutomationRun,
  ZCodeAutomationScheduleRule,
} from "@zcode/shared";

import { runSummary } from "./automationResults.js";
import { LINK_MODES, linkMode, macTimeZone, record, type LinkMode } from "./linkPolicy.js";

/**
 * [up-p3-mac] /automations 的纯函数部分(docs/specs/leo-link-automations.md):
 * 手机的计划写法 ↔ Mac 调度器的 cron、展示视图、请求校验、全自动调用方规则。
 */
export type ScheduleSpec = { cronExpr: string; recurring: boolean };

const MAX_PROMPT = 20_000;
const MAX_NAME = 100;
const DEFAULT_NAME_CHARS = 30;
const ONCE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

const pad = (value: number) => String(value).padStart(2, "0");
const seconds = (ms: number | undefined) => (typeof ms === "number" ? ms / 1000 : null);

function parseTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

function isWeekday(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6;
}

/** 只做形状预检(5 段、字符集);合法性交给自动化服务的 isValidCronExpr。 */
function cronShape(value: string): string | null {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[0-9A-Za-z*,/\-?#]+$/.test(field))
    ? fields.join(" ")
    : null;
}

/**
 * 手机给的计划 → Mac 调度器的 cron(本机时区)。接受 cron 字符串、{cron}、{kind:hourly|daily|weekly|once}。
 * once 精确到分钟,必须在将来 365 天内(五段 cron 没有年份,更远的表达不了)。
 */
export function parseSchedule(
  value: unknown,
  now: Date,
  options: { allowOnce?: boolean } = {},
): ScheduleSpec | { error: string } {
  if (typeof value === "string" || typeof record(value)["cron"] === "string") {
    const raw = typeof value === "string" ? value : String(record(value)["cron"]);
    const cronExpr = cronShape(raw);
    return cronExpr
      ? { cronExpr, recurring: true }
      : { error: "cron 必须是 5 段（分 时 日 月 周）" };
  }
  const spec = record(value);
  const kind = spec["kind"];
  if (kind === "hourly") {
    const minute = spec["minute"] ?? parseTime(spec["time"])?.minute ?? 0;
    if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59)
      return { error: "hourly 的 minute 必须是 0-59" };
    return { cronExpr: `${minute as number} * * * *`, recurring: true };
  }
  if (kind === "daily" || kind === "weekly") {
    const time = parseTime(spec["time"]);
    if (!time) return { error: "time 必须是 24 小时制 HH:MM" };
    if (kind === "daily") return { cronExpr: `${time.minute} ${time.hour} * * *`, recurring: true };
    const weekdays = Array.isArray(spec["weekdays"]) ? spec["weekdays"] : [spec["weekday"]];
    if (weekdays.length === 0 || !weekdays.every(isWeekday))
      return { error: "weekday 必须是 0-6（0=周日），或 weekdays 为 0-6 的数组" };
    const days = [...new Set(weekdays as number[])].sort((a, b) => a - b).join(",");
    return { cronExpr: `${time.minute} ${time.hour} * * ${days}`, recurring: true };
  }
  if (kind === "once") {
    if (options.allowOnce === false) return { error: "修改计划不支持 once：要一次性请新建" };
    let at: Date | null = null;
    if (typeof spec["at"] === "string") {
      const parsed = Date.parse(spec["at"]);
      at = Number.isNaN(parsed) ? null : new Date(parsed);
    } else if (typeof spec["date"] === "string") {
      const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec["date"].trim());
      const time = parseTime(spec["time"]);
      if (date && time) {
        at = new Date(
          Number(date[1]),
          Number(date[2]) - 1,
          Number(date[3]),
          time.hour,
          time.minute,
        );
        // 2026-02-30 这类会被 Date 滚到下个月:滚了就是非法日期。
        if (at.getDate() !== Number(date[3])) at = null;
      }
    }
    if (!at) return { error: "once 需要 at（ISO 8601）或 date（YYYY-MM-DD）+ time（HH:MM）" };
    at.setSeconds(0, 0);
    if (at.getTime() <= now.getTime()) return { error: "once 的时间已经过去" };
    if (at.getTime() - now.getTime() > ONCE_HORIZON_MS) return { error: "once 只能约 365 天以内" };
    return {
      cronExpr: `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`,
      recurring: false,
    };
  }
  return { error: "schedule 需要 cron 字符串，或 {kind: hourly|daily|weekly|once}" };
}

/** "1-5" / "1,3,5" / "0" → [1..5]…;认不出(名字、步长)返回 null。7 也是周日。 */
function weekdayList(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)(?:-(\d))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > 7 || to > 7 || from > to) return null;
    for (let day = from; day <= to; day += 1) days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}

function weekdaysHuman(days: number[]): string {
  if (days.join(",") === "1,2,3,4,5") return "工作日";
  if (days.join(",") === "0,6") return "周末";
  if (days.length === 7) return "每天";
  return `每周${days.map((day) => WEEKDAY_NAMES[day]).join("、")}`;
}

function ruleHuman(rule: ZCodeAutomationScheduleRule): string {
  const time = `${pad(rule.hour)}:${pad(rule.minute)}`;
  const every = (unit: string) =>
    rule.interval === 1 ? `每${unit}` : `每 ${rule.interval} ${unit}`;
  switch (rule.unit) {
    case "minute":
      return `每 ${rule.interval} 分钟`;
    case "hourly":
      return `${every("小时")}第 ${rule.minute} 分`;
    case "daily":
      return `${every("天")} ${time}`;
    case "weekly":
      return `${every("周")}${rule.weekdays?.length ? ` ${weekdaysHuman(rule.weekdays).replace(/^每周/, "周")}` : ""} ${time}`;
    case "monthly":
      return `${every("个月")} ${rule.monthDays?.length ? `${rule.monthDays.join("、")} 日 ` : ""}${time}`;
    default:
      return `${every("年")} ${time}`;
  }
}

export type ScheduleView = {
  kind: "hourly" | "daily" | "weekly" | "once" | "cron" | "custom";
  cron: string;
  human: string;
  recurring: boolean;
  time?: string;
  weekdays?: number[];
  minute?: number;
};

/** 自动化的计划 → 手机展示用(人话 + 原式)。scheduleRule 是桌面「自定义重复」,权威高于 cron。 */
export function describeSchedule(
  automation: Pick<ZCodeAutomation, "cronExpr" | "recurring" | "scheduleRule">,
): ScheduleView {
  const cron = automation.cronExpr;
  const base = { cron, recurring: automation.recurring };
  if (automation.scheduleRule)
    return { ...base, kind: "custom", human: ruleHuman(automation.scheduleRule) };
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = cron.trim().split(/\s+/);
  const digits = (value: string) => /^\d{1,2}$/.test(value);
  const time =
    digits(minute) && digits(hour) ? `${pad(Number(hour))}:${pad(Number(minute))}` : null;
  if (time && dom === "*" && month === "*") {
    if (dow === "*") return { ...base, kind: "daily", human: `每天 ${time}`, time };
    const weekdays = weekdayList(dow);
    if (weekdays)
      return {
        ...base,
        kind: "weekly",
        human: `${weekdaysHuman(weekdays)} ${time}`,
        time,
        weekdays,
      };
  }
  if (time && digits(dom) && digits(month) && dow === "*" && !automation.recurring)
    return {
      ...base,
      kind: "once",
      human: `${Number(month)}月${Number(dom)}日 ${time}（一次）`,
      time,
    };
  if (digits(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const value = Number(minute);
    return {
      ...base,
      kind: "hourly",
      human: value === 0 ? "每小时整点" : `每小时第 ${value} 分`,
      minute: value,
    };
  }
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === "*" && dom === "*" && month === "*" && dow === "*")
    return { ...base, kind: "cron", human: `每 ${step[1]} 分钟` };
  return { ...base, kind: "cron", human: `cron：${cron}` };
}

function lastRunStatus(run: ZCodeAutomationRun): string {
  if (run.outcome) return run.outcome;
  if (run.dispatchStatus === "failed_to_dispatch") return "dispatch_failed";
  if (run.dispatchStatus === "skipped") return "skipped";
  return "pending";
}

/** 最近一次运行(按创建时间)。 */
export function latestRun(runs: readonly ZCodeAutomationRun[]): ZCodeAutomationRun | undefined {
  return [...runs].sort((a, b) => b.createdAt - a.createdAt)[0];
}

/**
 * last_run.summary:运行结束时记下的摘要(最终回复 / 改判后的失败原因)优先;
 * 没记下的(别的窗口跑的、升级前跑的)失败 / 停止按运行记录现算,成功的给 null(不冷恢复会话去读)。
 */
function lastRunSummary(run: ZCodeAutomationRun, recorded: string | null | undefined): string | null {
  if (recorded) return recorded;
  if (run.outcome === "failed" || run.outcome === "stopped") return runSummary(run.outcome, run.error, null);
  return null;
}

export function automationView(
  automation: ZCodeAutomation,
  runs: ZCodeAutomationRun[],
  recordedSummary?: string | null,
) {
  const last = latestRun(runs);
  return {
    id: automation.automationId,
    name: automation.title,
    prompt: automation.prompt,
    schedule: describeSchedule(automation),
    // 计划按这个时区解释(Mac 本机)。
    time_zone: macTimeZone(),
    enabled: automation.enabled,
    state: automation.lifecycleStatus,
    workspace: automation.workspacePath,
    mode: automation.mode ?? null,
    target_task_id: automation.targetTaskId ?? null,
    run_count: automation.runCount,
    last_run: last
      ? {
          status: lastRunStatus(last),
          at: seconds(last.updatedAt),
          task_id: last.sessionId ?? null,
          // 同一个值:手机可直接打开 /harness/sessions/<session_id>/events。
          session_id: last.sessionId ?? null,
          trigger: last.trigger,
          error: last.error ?? null,
          summary: lastRunSummary(last, recordedSummary),
        }
      : null,
    next_run_at: automation.enabled ? seconds(automation.nextRunAt) : null,
    created_at: seconds(automation.createdAt),
    updated_at: seconds(automation.updatedAt),
  };
}

export type CreateInput = {
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  workspace: string;
  harness: string;
  mode: LinkMode;
};

function text(value: unknown, max: number, field: string): string | { error: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return { error: `${field} 必须是字符串` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} 不能为空` };
  if (trimmed.length > max) return { error: `${field} 不能超过 ${max} 字` };
  return trimmed;
}

const failed = (value: unknown): value is { error: string } =>
  Boolean(value) && typeof value === "object" && "error" in (value as object);

export function parseCreate(body: unknown, now: Date): CreateInput | { error: string } {
  const input = record(body);
  const prompt = text(input["prompt"], MAX_PROMPT, "prompt");
  if (failed(prompt)) return prompt;
  if (!prompt) return { error: "prompt 必填" };
  const name = text(input["name"], MAX_NAME, "name");
  if (failed(name)) return name;
  const schedule = parseSchedule(input["schedule"], now);
  if ("error" in schedule) return schedule;
  const workspace = input["workspace"] ?? input["cwd"];
  if (workspace !== undefined && workspace !== null && typeof workspace !== "string")
    return { error: "workspace 必须是路径字符串" };
  const harness = input["harness"];
  if (harness !== undefined && harness !== null && typeof harness !== "string")
    return { error: "harness 必须是字符串" };
  const mode = input["mode"] == null ? undefined : linkMode(input["mode"]);
  if (input["mode"] != null && !mode) return { error: `mode 只能是 ${LINK_MODES.join(" / ")}` };
  return {
    name: name ?? prompt.replace(/\s+/g, " ").slice(0, DEFAULT_NAME_CHARS),
    prompt,
    schedule,
    workspace: typeof workspace === "string" ? workspace.trim() : "",
    harness: (typeof harness === "string" && harness.trim()) || "zcode",
    mode: mode ?? (input["full_auto"] === true ? "yolo" : "build"),
  };
}

export type PatchInput = {
  name?: string;
  prompt?: string;
  schedule?: ScheduleSpec;
  enabled?: boolean;
  mode?: LinkMode;
};

export function parsePatch(body: unknown, now: Date): PatchInput | { error: string } {
  const input = record(body);
  const patch: PatchInput = {};
  const name = text(input["name"], MAX_NAME, "name");
  if (failed(name)) return name;
  if (name !== undefined) patch.name = name;
  const prompt = text(input["prompt"], MAX_PROMPT, "prompt");
  if (failed(prompt)) return prompt;
  if (prompt !== undefined) patch.prompt = prompt;
  if (input["schedule"] !== undefined) {
    const schedule = parseSchedule(input["schedule"], now, { allowOnce: false });
    if ("error" in schedule) return schedule;
    patch.schedule = schedule;
  }
  if (input["enabled"] !== undefined) {
    if (typeof input["enabled"] !== "boolean") return { error: "enabled 必须是 true / false" };
    patch.enabled = input["enabled"];
  }
  if (input["mode"] !== undefined) {
    const mode = linkMode(input["mode"]);
    if (!mode) return { error: `mode 只能是 ${LINK_MODES.join(" / ")}` };
    patch.mode = mode;
  }
  return Object.keys(patch).length
    ? patch
    : { error: "至少改一项：name / prompt / schedule / enabled / mode" };
}

/**
 * 会让全自动(yolo)跑起来、且内容或时机由调用方决定的写操作,按会话的规则要认得出设备(mayUseFullAuto)。
 * 只改名、停用、删除不受限:它们只会让自动化更安全。
 */
export function patchNeedsFullAuto(existingMode: string | undefined, patch: PatchInput): boolean {
  const resultingMode = patch.mode ?? existingMode;
  if (resultingMode !== "yolo") return false;
  return (
    patch.prompt !== undefined ||
    patch.schedule !== undefined ||
    patch.mode !== undefined ||
    patch.enabled === true
  );
}

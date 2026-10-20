// [takeover] 接管 Mac 终端里已开着的 Claude Code 会话(docs/specs/leo-link-takeover.md)。
// 只读 ~/.claude/projects/*/<uuid>.jsonl 的头尾:列表要 cwd、标题、更新时间;接管要最近一段历史。
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ACP_SESSIONS_FILE } from "@zcode/shared/acp";

import { toolInputField, toolOutputField, toolOutputText, toolTarget } from "./eventMap.js";
import type { HarnessEvent } from "./journal.js";

export type ExternalSession = {
  id: string;
  agent: "claude";
  cwd: string;
  title: string;
  updated_at: string;
  running: boolean;
  /** JSONL 的绝对路径(不发给手机)。 */
  file: string;
};

/** Claude Code 的会话 id 就是 JSONL 文件名:只认 uuid 形状,挡掉路径花样。 */
export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EXTERNAL_LIST_LIMIT = 20;
/** 最近这么久内文件有写入,就当终端里那个 claude 还开着。 */
export const RUNNING_WINDOW_MS = 60_000;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
/** 解析的候选上限:跳过 SDK 会话、没有 cwd 的之后,通常远不到这个数就凑够 20 个。 */
const CANDIDATE_LIMIT = 60;
/** 接管时回放的历史:只读文件尾部这么多,最多这么多条(日志待写队列约 2000 条 / 6MB)。 */
const HISTORY_BYTES = 2 * 1024 * 1024;
const HISTORY_EVENTS = 600;
const TITLE_CHARS = 60;

/** 用户消息里不是人话的那些:斜杠命令包装、命令输出、系统提醒、中断提示。 */
const NOT_SPEECH = /^\s*(<command-(name|message|args)>|<local-command-(stdout|stderr|caveat)>|<bash-(input|stdout|stderr)>|<user-prompt-submit-hook>|Caveat: |\[Request interrupted)/;

type Line = Record<string, unknown>;

/** 外部 agent 子进程用的 Claude 数据目录:CLAUDE_CONFIG_DIR,否则(LEO_ACP_AGENT_HOME 或)主目录下的 .claude。 */
export function defaultClaudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const config = env["CLAUDE_CONFIG_DIR"]?.trim() || path.join(env["LEO_ACP_AGENT_HOME"]?.trim() || os.homedir(), ".claude");
  return path.join(config, "projects");
}

/** CLI 的 ACP 会话映射;数据根与 CLI 同一个 ZCODE_HOME。 */
export function defaultAcpSessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env["ZCODE_HOME"]?.trim() || path.join(os.homedir(), ".leophoneagent"), "cli", ACP_SESSIONS_FILE);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseLines(text: string, { dropFirst, dropLast }: { dropFirst: boolean; dropLast: boolean }): Line[] {
  const raw = text.split("\n");
  // 读的是一段字节:首行 / 末行可能被截断,直接丢掉;坏行跳过。
  if (dropFirst) raw.shift();
  if (dropLast) raw.pop();
  const out: Line[] = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Line);
    } catch {
      // 坏行(写到一半、被截断)跳过
    }
  }
  return out;
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** 用户真正说的话(去掉系统提醒);工具结果、命令包装、meta 返回空串。 */
function userSpeech(line: Line): string {
  if (line["type"] !== "user" || line["isMeta"] === true || line["isSidechain"] === true || line["isCompactSummary"] === true)
    return "";
  const content = record(line["message"])["content"];
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => (record(block)["type"] === "text" ? String(record(block)["text"] ?? "") : ""))
            .filter(Boolean)
            .join("\n")
        : "";
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return NOT_SPEECH.test(cleaned) ? "" : cleaned;
}

function oneLine(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

/** 读一个 JSONL 的头尾,拿 cwd 与标题;不是交互式会话(SDK / claude -p)或没有 cwd 的返回 null。 */
export async function describeClaudeSession(file: string, mtimeMs: number, size: number, now = Date.now()): Promise<ExternalSession | null> {
  const id = path.basename(file, ".jsonl");
  if (!SESSION_UUID.test(id)) return null;
  const headLength = Math.min(size, HEAD_BYTES);
  const head = parseLines(await readRange(file, 0, headLength), { dropFirst: false, dropLast: size > headLength });
  const tailStart = Math.max(headLength, size - TAIL_BYTES);
  const tail = size > tailStart ? parseLines(await readRange(file, tailStart, size - tailStart), { dropFirst: true, dropLast: false }) : [];
  const first = head.find((line) => typeof line["entrypoint"] === "string");
  // ponytail: SDK 开的会话(LeoBot 自己的 ACP、claude -p)不算「终端里的会话」;以首条记录的 entrypoint 为准。
  if (String(first?.["entrypoint"] ?? "").startsWith("sdk-")) return null;
  const cwd = head.find((line) => typeof line["cwd"] === "string" && line["cwd"])?.["cwd"];
  if (typeof cwd !== "string") return null;
  // 标题:Claude Code 自己起的(custom-title,取最新的) → 第一条用户消息 → 最后一次输入。
  const lines = [...head, ...tail];
  const custom = lines.filter((line) => line["type"] === "custom-title").at(-1)?.["customTitle"];
  const firstSpeech = head.map(userSpeech).find(Boolean);
  const lastPrompt = lines.filter((line) => line["type"] === "last-prompt").at(-1)?.["lastPrompt"];
  const title = [custom, firstSpeech, lastPrompt].find((value): value is string => typeof value === "string" && value.trim() !== "") ?? "";
  return {
    id,
    agent: "claude",
    cwd,
    title: oneLine(title, TITLE_CHARS),
    updated_at: new Date(mtimeMs).toISOString(),
    running: now - mtimeMs < RUNNING_WINDOW_MS,
    file,
  };
}

async function sessionFiles(projectsDir: string): Promise<{ file: string; mtimeMs: number; size: number }[]> {
  let projects: string[];
  try {
    projects = await fsp.readdir(projectsDir);
  } catch {
    return [];
  }
  const files = (
    await Promise.all(
      projects.map(async (project) => {
        const dir = path.join(projectsDir, project);
        const names = await fsp.readdir(dir).catch(() => [] as string[]);
        return names.filter((name) => name.endsWith(".jsonl") && SESSION_UUID.test(name.slice(0, -6))).map((name) => path.join(dir, name));
      }),
    )
  ).flat();
  const stats = await Promise.all(
    files.map(async (file) => {
      const stat = await fsp.stat(file).catch(() => null);
      return stat?.isFile() ? { file, mtimeMs: stat.mtimeMs, size: stat.size } : null;
    }),
  );
  return stats.filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 最近的 Claude 交互式会话(按修改时间,最多 limit 个)。 */
export async function listClaudeSessions(projectsDir: string, limit = EXTERNAL_LIST_LIMIT, now = Date.now()): Promise<ExternalSession[]> {
  const out: ExternalSession[] = [];
  for (const entry of (await sessionFiles(projectsDir)).slice(0, CANDIDATE_LIMIT)) {
    if (out.length >= limit) break;
    const described = await describeClaudeSession(entry.file, entry.mtimeMs, entry.size, now).catch(() => null);
    if (described) out.push(described);
  }
  return out;
}

/** 按 id 找会话:只在 projectsDir 的直接子目录里找 <id>.jsonl(调用方先校验 uuid)。 */
export async function findClaudeSession(projectsDir: string, id: string, now = Date.now()): Promise<ExternalSession | null> {
  if (!SESSION_UUID.test(id)) return null;
  const projects = await fsp.readdir(projectsDir).catch(() => [] as string[]);
  for (const project of projects) {
    const file = path.join(projectsDir, project, `${id}.jsonl`);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat?.isFile()) return describeClaudeSession(file, stat.mtimeMs, stat.size, now);
  }
  return null;
}

/**
 * 最近一段对话翻成手机协议事件(user.message / message.delta / reasoning.available / tool.* / run.completed)。
 * 一条用户消息开一轮,下一条用户消息或结尾收轮;truncated = 更早的部分没读。
 */
export async function readClaudeHistory(file: string): Promise<{ events: HarnessEvent[]; truncated: boolean }> {
  const { size } = await fsp.stat(file);
  const start = Math.max(0, size - HISTORY_BYTES);
  const lines = parseLines(await readRange(file, start, size - start), { dropFirst: start > 0, dropLast: false });
  const events: HarnessEvent[] = [];
  const tools = new Map<string, string>();
  let open = false;
  const close = () => {
    if (open) events.push({ event: "run.completed" });
    open = false;
  };
  for (const line of lines) {
    if (line["isSidechain"] === true) continue;
    const speech = userSpeech(line);
    if (speech) {
      close();
      events.push({ event: "user.message", text: speech });
      open = true;
      continue;
    }
    const content = record(line["message"])["content"];
    if (!Array.isArray(content) || line["isMeta"] === true) continue;
    for (const raw of content) {
      const block = record(raw);
      if (line["type"] === "assistant") {
        open = true;
        if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].trim()) {
          // 两段正文之间没有别的事件时手机会拼成一段:补个空行。
          const joiner = events.at(-1)?.event === "message.delta" ? "\n\n" : "";
          events.push({ event: "message.delta", delta: joiner + block["text"] });
        } else if (block["type"] === "thinking" && typeof block["thinking"] === "string" && block["thinking"].trim()) {
          events.push({ event: "reasoning.available", text: block["thinking"].trim() });
        } else if (block["type"] === "tool_use" && typeof block["id"] === "string") {
          const name = typeof block["name"] === "string" && block["name"] ? block["name"] : "tool";
          tools.set(block["id"], name);
          events.push({
            event: "tool.started",
            tool: name,
            tool_use_id: block["id"],
            preview: toolTarget(block["input"]).slice(0, 200),
            ...toolInputField(block["input"]),
          });
        }
      } else if (line["type"] === "user" && block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
        const name = tools.get(block["tool_use_id"]);
        // 开头被截掉的工具(没见过 tool_use)不发:手机上没有对应的行可以闭合。
        if (!name) continue;
        tools.delete(block["tool_use_id"]);
        events.push({
          event: "tool.completed",
          tool: name,
          tool_use_id: block["tool_use_id"],
          error: block["is_error"] === true,
          ...toolOutputField(toolOutputText(block["content"])),
        });
      }
    }
  }
  close();
  const truncated = start > 0 || events.length > HISTORY_EVENTS;
  // 从一条用户消息开始截,别让手机上第一轮只剩半截回答。
  let kept = events.slice(-HISTORY_EVENTS);
  if (kept.length < events.length) {
    const firstUser = kept.findIndex((event) => event.event === "user.message");
    if (firstUser > 0) kept = kept.slice(firstUser);
  }
  return { events: kept, truncated };
}

/**
 * 让 LeoBot 任务的 ACP claude 用 session/load 续上这个 Claude 会话:在 CLI 的会话映射里预置
 * 「任务 id → Claude 会话 id」(CLI 第一次给这个任务拉起 agent 时读,见 adapters/acp/manager.ts)。
 * CLI 写映射是同步整文件覆盖,读到半截的 JSON 时稍等重试,绝不拿空表覆盖掉别的任务的映射。
 */
export async function seedAcpResume(statePath: string, taskId: string, acpSessionId: string): Promise<void> {
  let state: Record<string, unknown> = {};
  for (let attempt = 0; ; attempt += 1) {
    let text: string;
    try {
      text = await fsp.readFile(statePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") break;
      throw cause;
    }
    try {
      state = record(JSON.parse(text));
      break;
    } catch (cause) {
      if (attempt >= 4) throw new Error(`ACP 会话映射读不懂：${String(cause)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  state[taskId] = { agentId: "claude-code", acpSessionId };
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(state, null, 2));
  await fsp.rename(temp, statePath);
}

/**
 * [takeover] CLI 拉起 agent 后把实际的 ACP 会话 id 写回映射:还是终端那个 id = load 上了;
 * 变成别的 = load 失败、新开了会话。映射读不到 / 没这一条按「接上了」算,不误报。
 */
export async function acpResumeHeld(statePath: string, taskId: string, externalId: string): Promise<boolean> {
  const text = await fsp.readFile(statePath, "utf8").catch(() => "");
  let state: Record<string, unknown> = {};
  try {
    state = record(JSON.parse(text || "{}"));
  } catch {
    return true;
  }
  const current = record(state[taskId])["acpSessionId"];
  return typeof current !== "string" || current === externalId;
}

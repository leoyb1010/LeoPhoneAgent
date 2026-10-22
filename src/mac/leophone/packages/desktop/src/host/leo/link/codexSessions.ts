// [codex-sessions] Mac 上 Codex(桌面版与 CLI 共用 ~/.codex)的会话:列表、接管时回放的历史(docs/specs/leo-link-takeover.md)。
// 只读 sessions/YYYY/MM/DD/rollout-<时间>-<线程 id>[_<分段 id>].jsonl 的头尾、session_index.jsonl 的线程名、
// thread-writer-locks/<线程 id>.lock(Codex 打开着这个线程时才有)。
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { toolInputField, toolOutputField, toolOutputText, toolTarget } from "./eventMap.js";
import {
  EXTERNAL_LIST_LIMIT,
  type ExternalSession,
  HISTORY_BYTES,
  oneLine,
  parseLines,
  RUNNING_WINDOW_MS,
  readRange,
  record,
  SESSION_UUID,
  TITLE_CHARS,
  trimHistory,
} from "./externalSessions.js";
import type { HarnessEvent } from "./journal.js";

type Line = Record<string, unknown>;

const ROLLOUT = /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl$/i;
/** 从最新的日期目录往回最多看这么多个文件(按修改时间排序前的候选)。 */
const FILE_SCAN_LIMIT = 300;
const CANDIDATE_LIMIT = 60;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
/** 这一轮开着(task_started 之后没有 task_complete / turn_aborted)且这么久内有写入,算正在跑;更久的多半是崩了。 */
const OPEN_TURN_WINDOW_MS = 15 * 60_000;
const INDEX_BYTES = 2 * 1024 * 1024;
/** Codex 往用户消息里塞的上下文块(AGENTS.md、环境、浏览器 / 附件上下文、问答回执……):不是人话。 */
const NOT_SPEECH = /^\s*(<|# AGENTS\.md instructions)/;
/** LeoBot 自己经 codex-acp 开的线程(originator)不算「Mac 上的 Codex 会话」。 */
const OWN_ORIGINATOR = /^(leobot|leoagent)/i;

/** 外部 agent 子进程用的 Codex 数据目录:CODEX_HOME,否则(LEO_ACP_AGENT_HOME 或)主目录下的 .codex。 */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["CODEX_HOME"]?.trim() || path.join(env["LEO_ACP_AGENT_HOME"]?.trim() || os.homedir(), ".codex");
}

/** 用户真正说的话:去掉上下文块;附件清单只留「## My request…」之后那段。 */
function userSpeech(line: Line): string {
  const payload = record(line["payload"]);
  if (line["type"] !== "response_item" || payload["type"] !== "message" || payload["role"] !== "user") return "";
  const content = payload["content"];
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const block = record(raw);
    if (block["type"] !== "input_text" || typeof block["text"] !== "string") continue;
    let text = block["text"];
    if (/^\s*# Files mentioned by the user:/.test(text)) {
      const request = /^## My request[^\n]*\n/m.exec(text);
      text = request ? text.slice(request.index + request[0].length) : "";
    }
    if (text.trim() && !NOT_SPEECH.test(text)) parts.push(text.trim());
  }
  return parts.join("\n");
}

/** 最后一个轮次边界:started = 这一轮还没完;null = 尾部里没有边界。 */
function lastBoundary(lines: Line[]): "started" | "finished" | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const kind = record(line["payload"])["type"];
    if (line["type"] !== "event_msg") continue;
    if (kind === "task_started") return "started";
    if (kind === "task_complete" || kind === "turn_aborted") return "finished";
  }
  return null;
}

type Parsed = { cwd: string; title: string; boundary: "started" | "finished" | null } | null;
/** 解析结果按「文件 + 修改时间 + 大小」缓存:列表每次只重读变了的会话。 */
const parsedCache = new Map<string, Parsed>();

async function parseThread(files: string[], newest: { mtimeMs: number; size: number }): Promise<Parsed> {
  const key = `${files.join("|")}:${newest.mtimeMs}:${newest.size}`;
  if (parsedCache.has(key)) return parsedCache.get(key)!;
  const first = files[0]!;
  const last = files.at(-1)!;
  const firstSize = first === last ? newest.size : (await fsp.stat(first)).size;
  const headLength = Math.min(firstSize, HEAD_BYTES);
  const head = parseLines(await readRange(first, 0, headLength), { dropFirst: false, dropLast: firstSize > headLength });
  const tailStart = first === last ? Math.max(headLength, newest.size - TAIL_BYTES) : Math.max(0, newest.size - TAIL_BYTES);
  const tail =
    newest.size > tailStart ? parseLines(await readRange(last, tailStart, newest.size - tailStart), { dropFirst: tailStart > 0, dropLast: false }) : [];
  const meta = record(head.find((line) => line["type"] === "session_meta")?.["payload"]);
  let parsed: Parsed = null;
  // 只认交互式会话:Codex 桌面版(source vscode)与终端 codex(cli);codex exec、子 agent、LeoBot 自己开的不列。
  const source = meta["source"];
  const interactive = source === undefined || source === "vscode" || source === "cli";
  const own = typeof meta["originator"] === "string" && OWN_ORIGINATOR.test(meta["originator"]);
  if (interactive && !own && meta["thread_source"] !== "subagent" && typeof meta["cwd"] === "string" && meta["cwd"]) {
    // 只有一段时头尾是同一个文件:小文件整个都在 head 里。
    const recent = first === last ? [...head, ...tail] : tail;
    const lastSpeech = recent.map(userSpeech).filter(Boolean).at(-1);
    // 尾部 64KB 里一个轮次边界都没有:轮与轮之间只写几行,这么长只可能是一轮还在跑(工具输出堆起来的)。
    const boundary = lastBoundary(recent) ?? (newest.size > TAIL_BYTES ? "started" : null);
    parsed = { cwd: meta["cwd"], title: head.map(userSpeech).find(Boolean) ?? lastSpeech ?? "", boundary };
  }
  if (parsedCache.size > 500) parsedCache.clear();
  parsedCache.set(key, parsed);
  return parsed;
}

/** session_index.jsonl:线程 id → Codex 起的线程名(同一个 id 取最后一条)。 */
async function threadNames(codexHome: string): Promise<Map<string, string>> {
  const file = path.join(codexHome, "session_index.jsonl");
  const names = new Map<string, string>();
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return names;
  const start = Math.max(0, stat.size - INDEX_BYTES);
  for (const line of parseLines(await readRange(file, start, stat.size - start), { dropFirst: start > 0, dropLast: false })) {
    if (typeof line["id"] === "string" && typeof line["thread_name"] === "string" && line["thread_name"].trim())
      names.set(line["id"], line["thread_name"]);
  }
  return names;
}

type Thread = { id: string; files: string[]; mtimeMs: number; size: number };

async function readdirDesc(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name)).sort().reverse();
}

/** 从最新的日期目录往回找 rollout 文件,按线程归并(分段按文件名即时间排序),按最新修改时间排序。 */
async function threads(codexHome: string): Promise<Thread[]> {
  const root = path.join(codexHome, "sessions");
  const files: string[] = [];
  scan: for (const year of await readdirDesc(root))
    for (const month of await readdirDesc(path.join(root, year)))
      for (const day of await readdirDesc(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day);
        for (const name of await fsp.readdir(dir).catch(() => [] as string[])) if (ROLLOUT.test(name)) files.push(path.join(dir, name));
        if (files.length >= FILE_SCAN_LIMIT) break scan;
      }
  const byId = new Map<string, Thread>();
  for (const file of files) {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    const id = ROLLOUT.exec(path.basename(file))![1]!.toLowerCase();
    const thread = byId.get(id) ?? { id, files: [], mtimeMs: 0, size: 0 };
    thread.files.push(file);
    if (stat.mtimeMs >= thread.mtimeMs) Object.assign(thread, { mtimeMs: stat.mtimeMs, size: stat.size });
    byId.set(id, thread);
  }
  for (const thread of byId.values()) thread.files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Codex 打开着这个线程(桌面版或终端 codex 正持有写锁)时才有这个锁文件;崩溃残留的由 Codex 下次启动清掉。 */
export function codexLockFile(codexHome: string, id: string): string {
  return path.join(codexHome, "thread-writer-locks", `${id}.lock`);
}

async function lockedIds(codexHome: string): Promise<Set<string>> {
  const names = await fsp.readdir(path.join(codexHome, "thread-writer-locks")).catch(() => [] as string[]);
  return new Set(names.filter((name) => name.endsWith(".lock")).map((name) => name.slice(0, -5).toLowerCase()));
}

/** 锁文件真被某个进程开着(lsof);lsof 不在 / 超时按「开着」算,宁可让用户先关掉 Codex。 */
export function codexLockHeld(lockFile: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/sbin/lsof", ["-t", "--", lockFile], { timeout: 3000 }, (error, stdout) => {
      if (!error) return resolve(stdout.trim() !== "");
      // lsof 找不到持有者时退出码 1、无输出。
      resolve(!(typeof error.code === "number" && error.code === 1 && !stdout.trim()));
    });
  });
}

async function describe(thread: Thread, names: Map<string, string>, locked: Set<string>, now: number): Promise<ExternalSession | null> {
  const parsed = await parseThread(thread.files, thread);
  if (!parsed) return null;
  const busy = parsed.boundary === "started" && now - thread.mtimeMs < OPEN_TURN_WINDOW_MS;
  return {
    id: thread.id,
    agent: "codex",
    cwd: parsed.cwd,
    title: oneLine(names.get(thread.id) || parsed.title, TITLE_CHARS),
    updated_at: new Date(thread.mtimeMs).toISOString(),
    running: locked.has(thread.id) || busy || now - thread.mtimeMs < RUNNING_WINDOW_MS,
    busy,
    file: thread.files.at(-1)!,
    files: thread.files,
  };
}

/** 最近的 Codex 交互式会话(按修改时间,最多 limit 个)。 */
export async function listCodexSessions(codexHome: string, limit = EXTERNAL_LIST_LIMIT, now = Date.now()): Promise<ExternalSession[]> {
  const [all, names, locked] = await Promise.all([threads(codexHome), threadNames(codexHome), lockedIds(codexHome)]);
  const out: ExternalSession[] = [];
  for (const thread of all.slice(0, CANDIDATE_LIMIT)) {
    if (out.length >= limit) break;
    const described = await describe(thread, names, locked, now).catch(() => null);
    if (described) out.push(described);
  }
  return out;
}

/** 按线程 id 找会话(调用方先校验 uuid)。 */
export async function findCodexSession(codexHome: string, id: string, now = Date.now()): Promise<ExternalSession | null> {
  if (!SESSION_UUID.test(id)) return null;
  const thread = (await threads(codexHome)).find((candidate) => candidate.id === id.toLowerCase());
  if (!thread) return null;
  const [names, locked] = await Promise.all([threadNames(codexHome), lockedIds(codexHome)]);
  return describe(thread, names, locked, now);
}

/** 工具输入:arguments 是 JSON 字符串就解析;custom 工具(apply_patch、exec)的输入是原文。 */
function toolInput(payload: Record<string, unknown>): unknown {
  if (typeof payload["arguments"] === "string") {
    try {
      return JSON.parse(payload["arguments"]);
    } catch {
      return { arguments: payload["arguments"] };
    }
  }
  if (typeof payload["input"] === "string") return { input: payload["input"] };
  return record(payload["action"]);
}

function toolPreview(input: unknown): string {
  const obj = record(input);
  const command = obj["command"] ?? obj["cmd"];
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof command === "string") return command;
  return toolTarget(input) || String(obj["input"] ?? "").split("\n")[0] || "";
}

/** 读最近一段(各分段从新往旧凑够 HISTORY_BYTES)。 */
async function recentLines(files: string[]): Promise<{ lines: Line[]; cut: boolean }> {
  let budget = HISTORY_BYTES;
  const chunks: Line[][] = [];
  let cut = false;
  for (const file of [...files].reverse()) {
    const { size } = await fsp.stat(file);
    const start = Math.max(0, size - budget);
    chunks.unshift(parseLines(await readRange(file, start, size - start), { dropFirst: start > 0, dropLast: false }));
    budget -= size - start;
    if (start > 0 || budget <= 0) {
      cut = start > 0 || file !== files[0];
      break;
    }
  }
  return { lines: chunks.flat(), cut };
}

/** 最近一段对话翻成手机协议事件(与 readClaudeHistory 同一套):一条用户消息开一轮,轮次结束 / 下一条用户消息收轮。 */
export async function readCodexHistory(files: string[]): Promise<{ events: HarnessEvent[]; truncated: boolean }> {
  const { lines, cut } = await recentLines(files);
  const events: HarnessEvent[] = [];
  const tools = new Map<string, string>();
  let open = false;
  const close = () => {
    if (open) events.push({ event: "run.completed" });
    open = false;
  };
  for (const line of lines) {
    const payload = record(line["payload"]);
    const kind = payload["type"];
    if (line["type"] === "event_msg") {
      if (kind === "task_complete" || kind === "turn_aborted") close();
      continue;
    }
    if (line["type"] !== "response_item") continue;
    const speech = userSpeech(line);
    if (speech) {
      close();
      events.push({ event: "user.message", text: speech });
      open = true;
      continue;
    }
    if (kind === "message" && payload["role"] === "assistant" && Array.isArray(payload["content"])) {
      const text = payload["content"]
        .map((block) => (record(block)["type"] === "output_text" ? String(record(block)["text"] ?? "") : ""))
        .join("")
        .trim();
      if (!text) continue;
      open = true;
      const joiner = events.at(-1)?.event === "message.delta" ? "\n\n" : "";
      events.push({ event: "message.delta", delta: joiner + text });
    } else if (kind === "reasoning" && Array.isArray(payload["summary"])) {
      const text = payload["summary"].map((block) => String(record(block)["text"] ?? "")).join("\n").trim();
      if (!text) continue;
      open = true;
      events.push({ event: "reasoning.available", text });
    } else if ((kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") && typeof payload["call_id"] === "string") {
      const name = typeof payload["name"] === "string" && payload["name"] ? payload["name"] : kind === "local_shell_call" ? "shell" : "tool";
      const input = toolInput(payload);
      tools.set(payload["call_id"], name);
      open = true;
      events.push({ event: "tool.started", tool: name, tool_use_id: payload["call_id"], preview: toolPreview(input).slice(0, 200), ...toolInputField(input) });
    } else if ((kind === "function_call_output" || kind === "custom_tool_call_output") && typeof payload["call_id"] === "string") {
      const name = tools.get(payload["call_id"]);
      // 开头被截掉的工具(没见过调用)不发:手机上没有对应的行可以闭合。
      if (!name) continue;
      tools.delete(payload["call_id"]);
      const output = payload["output"];
      events.push({
        event: "tool.completed",
        tool: name,
        tool_use_id: payload["call_id"],
        error: record(output)["success"] === false,
        ...toolOutputField(toolOutputText(output)),
      });
    }
  }
  close();
  return trimHistory(events, cut);
}

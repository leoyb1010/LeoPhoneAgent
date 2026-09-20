import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEOAGENT_HOME } from './leoagent-home.js';
import type { HarnessLaunchContext } from './harness-specs.js';

// pi 作为 leocodebox 自带的代理运行时。
//
// 2.0 的内核路线:不再依赖用户外装的 CLI,而是把 @earendil-works/pi-coding-agent
// 的 rpc-entry(自包含的 JSONL RPC 进程)打进应用,用宿主的 Node 直接跑。
// 事件仍走既有的 pi_rpc 方言 → HarnessSession 日志 → iOS / relay / 渲染层,
// 协议一字不改,只换了发事件的源头。
//
// 目录布局(全部在 LEOAGENT_HOME/pi 下,不碰用户自己的 ~/.pi):
//   auth.json      供应商凭据(pi-ai 的 auth.json 格式)
//   extensions/    leo-approval.ts —— 审批策略与「本会话允许」
//   sessions/      pi 自己的会话 JSONL
//   policy/        每条 harness 会话的策略文件(服务端写,extension 每次工具调用读)

export const PI_HOME = path.join(LEOAGENT_HOME, 'pi');
export const PI_EXTENSIONS_DIR = path.join(PI_HOME, 'extensions');
export const PI_SESSIONS_DIR = path.join(PI_HOME, 'sessions');
export const PI_POLICY_DIR = path.join(PI_HOME, 'policy');
export const PI_AUTH_PATH = path.join(PI_HOME, 'auth.json');
export const PI_MODELS_PATH = path.join(PI_HOME, 'models.json');

export type ApprovalPolicy = 'default' | 'accept_edits' | 'plan' | 'auto';

const POLICY_ALIASES: Record<string, ApprovalPolicy> = {
  default: 'default', '默认审批': 'default',
  accept_edits: 'accept_edits', acceptedits: 'accept_edits', '接受编辑': 'accept_edits',
  plan: 'plan', '计划模式': 'plan',
  auto: 'auto', bypasspermissions: 'auto', '全自动': 'auto', '跳过审批': 'auto',
};

/** 五种历史叫法(UI 中文 / 旧 permissionMode)统一成四种策略;认不出来一律回落到最保守的 default。 */
export function normalizePolicy(input: unknown): ApprovalPolicy {
  const raw = String(input ?? '').trim();
  return POLICY_ALIASES[raw] ?? POLICY_ALIASES[raw.toLowerCase()] ?? 'default';
}

// -- 运行时定位 -------------------------------------------------------------

let cachedEntry: string | null | undefined;

/**
 * 找到打进应用的 rpc-entry.js。先走 import.meta.resolve(尊重 package exports),
 * 失败再沿目录向上找 node_modules —— 打包后的 app 是 asar:false 的平铺目录,
 * 两条路都能命中。找不到返回 null,harness 列表里就不会出现 pi。
 */
export function resolveRpcEntry(): string | null {
  if (cachedEntry !== undefined) return cachedEntry;
  let found: string | null = null;
  try {
    const url = import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry');
    const candidate = fileURLToPath(url);
    if (fs.existsSync(candidate)) found = candidate;
  } catch {
    // fall through to the directory walk
  }
  if (!found) {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'rpc-entry.js');
      if (fs.existsSync(candidate)) { found = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  cachedEntry = found;
  return found;
}

/** 子进程用哪个 Node:Electron 里就是自己(ELECTRON_RUN_AS_NODE),开发态就是当前 node。 */
export function resolveCommand(): { command: string; env: Record<string, string> } | null {
  if (!resolveRpcEntry()) return null;
  const env: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  return { command: process.execPath, env };
}

export function buildArgs(ctx: HarnessLaunchContext): string[] {
  const entry = resolveRpcEntry();
  if (!entry) throw new Error('pi runtime is not bundled with this build');
  const args = [entry, '--session-dir', PI_SESSIONS_DIR];
  if (ctx.model) args.push('--provider', ctx.model.provider, '--model', ctx.model.modelId);
  return args;
}

export function buildEnv(
  env: Record<string, string | undefined>,
  ctx: HarnessLaunchContext,
): Record<string, string | undefined> {
  return {
    ...env,
    ...(resolveCommand()?.env ?? {}),
    PI_CODING_AGENT_DIR: PI_HOME,
    PI_CODING_AGENT_SESSION_DIR: PI_SESSIONS_DIR,
    // 离线:不查更新、不发遥测 —— 这是嵌在别人应用里的运行时,不该自己联网。
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    NO_COLOR: '1',
    LEO_HARNESS_SESSION: ctx.sessionId,
    LEO_POLICY_FILE: policyFilePath(ctx.sessionId),
    LEO_HOST: os.hostname(),
  };
}

// -- 策略文件 ---------------------------------------------------------------

export type PolicyFile = { policy: ApprovalPolicy; allow: string[] };

export function policyFilePath(sessionId: string): string {
  return path.join(PI_POLICY_DIR, `${sessionId}.json`);
}

export function readPolicy(sessionId: string): PolicyFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(policyFilePath(sessionId), 'utf8')) as Partial<PolicyFile>;
    return { policy: normalizePolicy(parsed.policy), allow: Array.isArray(parsed.allow) ? parsed.allow.map(String) : [] };
  } catch {
    return { policy: 'default', allow: [] };
  }
}

/** 只改策略,保留已经授出的「本会话允许」范围。 */
export function writePolicy(sessionId: string, policy: ApprovalPolicy, allow?: string[]): void {
  ensureDirs();
  const current = readPolicy(sessionId);
  const next: PolicyFile = { policy, allow: allow ?? current.allow };
  fs.writeFileSync(policyFilePath(sessionId), JSON.stringify(next), { mode: 0o600 });
}

// -- 凭据(pi-ai auth.json 格式) ----------------------------------------------

type AuthEntry = { type: 'api_key'; key: string } | { type: 'oauth'; [k: string]: unknown };

export function readAuth(): Record<string, AuthEntry> {
  try {
    return JSON.parse(fs.readFileSync(PI_AUTH_PATH, 'utf8')) as Record<string, AuthEntry>;
  } catch {
    return {};
  }
}

function writeAuth(auth: Record<string, AuthEntry>): void {
  ensureDirs();
  fs.writeFileSync(PI_AUTH_PATH, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export function setApiKey(provider: string, key: string): void {
  const auth = readAuth();
  auth[provider] = { type: 'api_key', key };
  writeAuth(auth);
}

export function clearAuth(provider: string): void {
  const auth = readAuth();
  delete auth[provider];
  writeAuth(auth);
}

/** 只报有没有、是哪种,绝不把密钥本身送出服务端。 */
export function authStatus(): Record<string, 'api_key' | 'oauth'> {
  const out: Record<string, 'api_key' | 'oauth'> = {};
  for (const [provider, entry] of Object.entries(readAuth())) {
    if (entry && typeof entry === 'object' && (entry.type === 'api_key' || entry.type === 'oauth')) out[provider] = entry.type;
  }
  return out;
}

/** 本机 pi 会话能不能开:至少一家供应商已经登录或填了密钥。 */
export function hasAnyPiAuth(status: Record<string, string> = authStatus()): boolean {
  return Object.keys(status).length > 0;
}

// -- 落盘 -------------------------------------------------------------------

export function ensureDirs(): void {
  for (const dir of [PI_HOME, PI_EXTENSIONS_DIR, PI_SESSIONS_DIR, PI_POLICY_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** 启动前:目录、extension、策略文件就位。extension 内容变了就覆写(版本随应用走)。 */
export async function prepare(ctx: HarnessLaunchContext): Promise<void> {
  ensureDirs();
  const extPath = path.join(PI_EXTENSIONS_DIR, 'leo-approval.ts');
  let current = '';
  try { current = fs.readFileSync(extPath, 'utf8'); } catch { /* first run */ }
  if (current !== APPROVAL_EXTENSION_SOURCE) fs.writeFileSync(extPath, APPROVAL_EXTENSION_SOURCE, { mode: 0o600 });
  if (!fs.existsSync(policyFilePath(ctx.sessionId))) writePolicy(ctx.sessionId, normalizePolicy(ctx.policy), []);
}

/**
 * 审批 extension。pi 内置工具默认不问人;这个钩子把「需要确认」接回我们的
 * 审批链:tool_call → 读策略 → ctx.ui.select → RPC extension_ui_request →
 * pi_rpc 方言 → approval.request → Mac / iPhone / Telegram 任一端答复。
 *
 * 规则与 iOS SensitiveToolGate 对齐:
 *   default       读类工具放行;bash / edit / write 问
 *   accept_edits  edit / write 放行;bash 问
 *   plan          bash / edit / write 一律拦(只分析不改动)
 *   auto          全放行
 * 「本会话允许」= sha256(host | cwd | tool | 完整命令),改一个字都要重新批。
 */
const APPROVAL_EXTENSION_SOURCE = `// 由 leocodebox 生成,随应用版本覆写,勿手改。
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

const MUTATING = new Set(["bash", "edit", "write"]);

function readPolicy(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { policy: "default", allow: [] }; }
}

function describe(tool, input) {
  if (tool === "bash") return String((input && input.command) || "");
  if (tool === "edit" || tool === "write") return tool + " " + String((input && input.path) || "");
  return tool + " " + JSON.stringify(input || {}).slice(0, 200);
}

export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const file = process.env.LEO_POLICY_FILE;
    if (!file) return;
    const tool = String(event.toolName || "");
    if (!MUTATING.has(tool)) return;
    const p = readPolicy(file);
    if (p.policy === "auto") return;
    if (p.policy === "plan") {
      return { block: true, reason: "计划模式:只分析和列计划,不落改动。要执行请把审批策略切到「默认审批」。" };
    }
    if (p.policy === "accept_edits" && tool !== "bash") return;

    const host = process.env.LEO_HOST || os.hostname();
    const input = event.input || {};
    const command = describe(tool, input);
    const scope = crypto.createHash("sha256").update(host + "|" + ctx.cwd + "|" + tool + "|" + command).digest("hex");
    if (Array.isArray(p.allow) && p.allow.includes(scope)) return;

    const title = JSON.stringify({ leo: 1, title: "要在 " + host + " 上执行", tool, command, cwd: ctx.cwd, host, scope, args: input });
    const choice = await ctx.ui.select(title, ["once", "session", "deny"]);
    if (choice === "session") {
      const cur = readPolicy(file);
      cur.allow = Array.from(new Set([...(Array.isArray(cur.allow) ? cur.allow : []), scope]));
      try { fs.writeFileSync(file, JSON.stringify(cur)); } catch {}
      return;
    }
    if (choice === "once") return;
    return { block: true, reason: choice === "deny" ? "用户拒绝了这条操作" : "审批未完成(超时或取消),这条操作没有执行" };
  });
}
`;

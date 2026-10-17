// [fix-remote] 外部 agent 的远程登录（node-only）：手机连上 Mac 后，Mac 上某个 CLI 没登录时，在手机上点开网页完成登录。
//
// Mac 在伪终端里跑各 CLI 的无界面登录，解析输出里的授权网址 / 设备码交给手机：
//   grok   `grok login --device-auth`  → 网址 + 设备码，用户在手机网页确认后进程自己退出（写 ~/.grok/auth.json）
//   codex  `codex login --device-auth` → 网址 + 一次性码，同上（写 ~/.codex/auth.json）
//   claude `claude setup-token`        → 授权网址；手机网页给出授权码，回填到 stdin 后 CLI 打印一年期令牌，
//                                        Mac 解析出令牌写进 <数据根>/acp/claude-oauth-token（0600），绝不进日志
//   gemini API key 粘贴 → ~/.gemini/.env 的 GEMINI_API_KEY
//   opencode API key 粘贴 → ~/.local/share/opencode/auth.json（默认 provider = opencode）
// 状态机：starting → waiting_for_user →（需要回填时 verifying）→ succeeded / failed / cancelled。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AcpAgentId } from "./acp.js";
import {
  ACP_HOST_ENV_KEYS,
  acpSearchPath,
  claudeOAuthTokenPath,
  detectAcpAgent,
  readClaudeOAuthToken,
  readDotEnvFile,
  writeClaudeOAuthToken,
} from "./acp-detect.js";
import { withSystemProxy } from "./system-proxy.js";

export type AcpLoginStatus = "starting" | "waiting_for_user" | "verifying" | "succeeded" | "failed" | "cancelled";
export type AcpLoginKind = "device" | "auth_code" | "api_key";

export interface AcpLoginFlowView {
  flow_id: string;
  agent: AcpAgentId;
  kind: AcpLoginKind;
  status: AcpLoginStatus;
  /** 在手机上打开的网址（授权页 / 设备码页 / 拿 API key 的页面）。 */
  url?: string;
  /** 设备码（grok / codex），手机上可复制。 */
  user_code?: string;
  /** 需要把网页给的授权码（claude）或 API key（gemini / opencode）回填给 Mac。 */
  needs_code: boolean;
  code_kind?: "auth_code" | "api_key";
  message?: string;
  started_at: number;
}

export interface AcpAuthState {
  agent: AcpAgentId;
  /** true 已登录；false 确认没登录；null 判断不了（例如 Claude 用钥匙串）。 */
  logged_in: boolean | null;
  method?: string;
  login_kind: AcpLoginKind;
}

// -- 输出解析（纯函数，测试用录下来的样例输出） ---------------------------------------

/** 去掉终端控制序列（CSI、OSC 含超链接、单字符转义）与回车。 */
export function stripTerminal(text: string): string {
  return (
    text
      // OSC：ESC ] … BEL / ST
      // eslint-disable-next-line no-control-regex -- 终端控制序列
      .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "")
      // eslint-disable-next-line no-control-regex -- 终端控制序列
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex -- 终端控制序列
      .replace(/\u001b[78=>()][0-9A-Za-z]?/g, "")
      .replace(/\r/g, "")
  );
}

function firstUrl(raw: string, prefix: RegExp): string | undefined {
  // 网址可能在 OSC 8 超链接里（claude），先在原文里找，以 BEL / 空白 / 引号结束。
  // eslint-disable-next-line no-control-regex -- 终端控制序列
  for (const match of raw.matchAll(/https:\/\/[^\s\u0007\u001b"'<>]+/g)) {
    if (prefix.test(match[0])) return match[0];
  }
  return undefined;
}

export function parseGrokLogin(raw: string): { url?: string; userCode?: string } {
  const text = stripTerminal(raw);
  const url = firstUrl(raw, /^https:\/\/[^/]*x\.ai\/oauth2\/device/);
  const code =
    /user_code=([A-Z0-9]{3,6}-[A-Z0-9]{3,6})/.exec(url ?? "")?.[1] ??
    /Confirm this code[^\n]*\n\s*([A-Z0-9]{3,6}-[A-Z0-9]{3,6})/i.exec(text)?.[1];
  return { ...(url ? { url } : {}), ...(code ? { userCode: code } : {}) };
}

export function parseCodexLogin(raw: string): { url?: string; userCode?: string } {
  const text = stripTerminal(raw);
  const url = firstUrl(raw, /^https:\/\/auth\.openai\.com\//);
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{3,6}-[A-Z0-9]{3,8})/i.exec(text)?.[1];
  return { ...(url ? { url } : {}), ...(code ? { userCode: code } : {}) };
}

export function parseClaudeSetupToken(raw: string): { url?: string; token?: string; asksForCode: boolean } {
  const text = stripTerminal(raw);
  const url = firstUrl(raw, /^https:\/\/claude\.(com|ai)\/[^\s]*oauth\/authorize/);
  const token = /\b(sk-ant-oat01-[A-Za-z0-9_-]{20,})/.exec(text)?.[1];
  return { ...(url ? { url } : {}), ...(token ? { token } : {}), asksForCode: /paste\s*code/i.test(text) };
}

/** 给手机看的失败说明：去控制序列、去令牌，取最后几行。 */
export function loginFailureText(raw: string): string {
  const lines = stripTerminal(raw)
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[已隐藏]")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-4).join(" | ").slice(0, 300);
}

// -- 登录状态 -----------------------------------------------------------------------

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

function opencodeAuthPath(env: NodeJS.ProcessEnv): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home(env), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

const LOGIN_KIND: Record<AcpAgentId, AcpLoginKind> = {
  "claude-code": "auth_code",
  codex: "device",
  gemini: "api_key",
  opencode: "api_key",
  grok: "device",
};

/** 粗判登录状态：只看凭据文件 / 令牌 / API key 在不在，不读内容给别人看。 */
export function acpAuthState(agent: AcpAgentId, env: NodeJS.ProcessEnv = process.env): AcpAuthState {
  const base = { agent, login_kind: LOGIN_KIND[agent] };
  switch (agent) {
    case "claude-code":
      // 钥匙串里的登录判断不了；有长期令牌就算已登录。
      return readClaudeOAuthToken(env) ? { ...base, logged_in: true, method: "long-lived-token" } : { ...base, logged_in: null };
    case "grok":
      return existsSync(join(home(env), ".grok", "auth.json"))
        ? { ...base, logged_in: true, method: "grok.com" }
        : { ...base, logged_in: false };
    case "codex":
      return existsSync(join(home(env), ".codex", "auth.json")) || env.OPENAI_API_KEY?.trim()
        ? { ...base, logged_in: true, method: env.OPENAI_API_KEY?.trim() ? "api-key" : "chatgpt" }
        : { ...base, logged_in: false };
    case "gemini": {
      const dot = readDotEnvFile(join(home(env), ".gemini", ".env"));
      if (env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || dot.GEMINI_API_KEY || dot.GOOGLE_API_KEY) {
        return { ...base, logged_in: true, method: "gemini-api-key" };
      }
      return existsSync(join(home(env), ".gemini", "oauth_creds.json"))
        ? { ...base, logged_in: true, method: "oauth-personal" }
        : { ...base, logged_in: false };
    }
    case "opencode": {
      try {
        const parsed = JSON.parse(readFileSync(opencodeAuthPath(env), "utf8")) as Record<string, unknown>;
        return Object.keys(parsed).length > 0 ? { ...base, logged_in: true, method: Object.keys(parsed)[0] } : { ...base, logged_in: false };
      } catch {
        return { ...base, logged_in: false };
      }
    }
  }
}

// -- 凭据写入（只写，不回显） -----------------------------------------------------------

function writeGeminiApiKey(key: string, env: NodeJS.ProcessEnv): void {
  const file = join(home(env), ".gemini", ".env");
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }
  const kept = lines.filter((line) => !/^\s*(export\s+)?GEMINI_API_KEY\s*=/.test(line) && line.trim() !== "");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, [...kept, `GEMINI_API_KEY=${key}`, ""].join("\n"), { mode: 0o600 });
}

function writeOpencodeApiKey(key: string, provider: string, env: NodeJS.ProcessEnv): void {
  const file = opencodeAuthPath(env);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...current, [provider]: { type: "api", key } }, null, 2), { mode: 0o600 });
}

// -- 流程 -------------------------------------------------------------------------

/** 登录进程的最小接口：桌面端用 node-pty（claude 要往伪终端回填授权码），测试用假进程。 */
export interface AcpLoginProcess {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  write(data: string): void;
  kill(): void;
}

export type AcpLoginSpawner = (command: string, args: string[], env: Record<string, string>) => AcpLoginProcess;

interface Flow {
  view: AcpLoginFlowView;
  child?: AcpLoginProcess;
  exited?: boolean;
  output: string;
  timer?: NodeJS.Timeout;
  provider?: string;
}

export interface AcpLoginFlowsOptions {
  env?: NodeJS.ProcessEnv;
  /** 伪终端进程（桌面端注入 node-pty）；不给时用 script(1)，只够设备码流程（没法回填 stdin）。 */
  spawnLogin?: AcpLoginSpawner;
  now?: () => number;
  /** 整个流程最长多久（默认 15 分钟，设备码的有效期）。 */
  timeoutMs?: number;
}

const API_KEY_PAGES: Partial<Record<AcpAgentId, string>> = {
  gemini: "https://aistudio.google.com/apikey",
  opencode: "https://opencode.ai/auth",
};

function loginEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(withSystemProxy({ ...env }))) {
    if (typeof value === "string") out[key] = value;
  }
  for (const key of ACP_HOST_ENV_KEYS) delete out[key];
  out.PATH = acpSearchPath(env).join(delimiter);
  // 不要在 Mac 上弹浏览器（网址给手机）。
  out.BROWSER = "true";
  return out;
}

/**
 * 兜底：macOS 的 script(1) 给 CLI 一个伪终端（stdin 只能是 /dev/null —— script 对管道 stdin 直接报错），
 * 先把终端设宽，长网址不被折行。claude 需要回填授权码，必须由调用方注入真正的 PTY（node-pty）。
 */
export const scriptLoginSpawner: AcpLoginSpawner = (command, args, env) => {
  const child = spawn(
    "/usr/bin/script",
    ["-q", "/dev/null", "/bin/sh", "-c", 'stty cols 2000 rows 60 2>/dev/null; exec "$0" "$@"', command, ...args],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  return {
    onData: (listener) => {
      child.stdout?.on("data", (chunk: Buffer) => listener(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString()));
    },
    onExit: (listener) => {
      child.on("exit", (code) => listener(code));
      child.on("error", () => listener(-1));
    },
    write: () => {
      throw new Error("这个登录方式需要伪终端（node-pty）");
    },
    kill: () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    },
  };
};

/** node-pty 的最小形状（shared 不依赖 node-pty，由桌面端把模块传进来）。 */
export interface NodePtyLike {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
  ): {
    onData(listener: (data: string) => void): unknown;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
    write(data: string): void;
    kill(signal?: string): void;
  };
}

/** 真伪终端：claude 的授权码回填靠它。列宽给足，长网址 / 令牌不折行。 */
export function nodePtyLoginSpawner(pty: NodePtyLike): AcpLoginSpawner {
  return (command, args, env) => {
    const term = pty.spawn(command, args, { name: "xterm-256color", cols: 2000, rows: 60, cwd: env.HOME, env });
    return {
      onData: (listener) => void term.onData(listener),
      onExit: (listener) => void term.onExit((event) => listener(event.exitCode)),
      write: (data) => term.write(data),
      kill: () => term.kill(),
    };
  };
}

export class AcpLoginFlows {
  readonly #flows = new Map<string, Flow>();
  readonly #env: NodeJS.ProcessEnv;
  readonly #spawn: NonNullable<AcpLoginFlowsOptions["spawnLogin"]>;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(options: AcpLoginFlowsOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#spawn = options.spawnLogin ?? scriptLoginSpawner;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  start(agent: AcpAgentId, options: { provider?: string } = {}): AcpLoginFlowView {
    // 同一个 agent 只留一个进行中的流程。
    for (const flow of this.#flows.values()) {
      if (flow.view.agent === agent && !this.#done(flow)) this.#finish(flow, "cancelled");
    }
    const flowId = randomUUID();
    const kind = LOGIN_KIND[agent];
    const view: AcpLoginFlowView = {
      flow_id: flowId,
      agent,
      kind,
      status: "starting",
      needs_code: kind !== "device",
      ...(kind === "api_key" ? { code_kind: "api_key" as const, url: API_KEY_PAGES[agent], status: "waiting_for_user" as const } : {}),
      ...(kind === "auth_code" ? { code_kind: "auth_code" as const } : {}),
      started_at: this.#now(),
    };
    const flow: Flow = { view, output: "", ...(options.provider ? { provider: options.provider } : {}) };
    this.#flows.set(flowId, flow);
    this.#prune();
    if (kind === "api_key") return { ...view };

    const status = detectAcpAgent(agent, { env: this.#env });
    if (!status.cliPath) {
      this.#finish(flow, "failed", status.unavailableReason ?? "这台 Mac 上没有这个 CLI");
      return { ...flow.view };
    }
    const args =
      agent === "grok" ? ["login", "--device-auth"] : agent === "codex" ? ["login", "--device-auth"] : ["setup-token"];
    let child: AcpLoginProcess;
    try {
      child = this.#spawn(status.cliPath, args, loginEnv(this.#env));
    } catch (error) {
      this.#finish(flow, "failed", error instanceof Error ? error.message : String(error));
      return { ...flow.view };
    }
    flow.child = child;
    child.onData((chunk) => {
      flow.output = (flow.output + chunk).slice(-64 * 1024);
      this.#parse(flow);
    });
    child.onExit((code) => {
      flow.exited = true;
      if (this.#done(flow)) return;
      if (agent === "claude-code") {
        this.#parse(flow);
        if (this.#done(flow) || flow.view.status === "verifying") return;
        this.#finish(flow, "failed", loginFailureText(flow.output) || `claude setup-token 退出（${code ?? "?"}）`);
        return;
      }
      if (code === 0) this.#finish(flow, "succeeded");
      else this.#finish(flow, "failed", loginFailureText(flow.output) || `登录进程退出（${code ?? "?"}）`);
    });
    flow.timer = setTimeout(() => this.#finish(flow, "failed", "等太久没完成登录，已取消"), this.#timeoutMs);
    flow.timer.unref?.();
    return { ...flow.view };
  }

  get(flowId: string): AcpLoginFlowView | undefined {
    const flow = this.#flows.get(flowId);
    return flow ? { ...flow.view } : undefined;
  }

  /** 回填授权码（claude）或 API key（gemini / opencode）。内容不进日志、不回显。 */
  async submit(flowId: string, code: string): Promise<AcpLoginFlowView | undefined> {
    const flow = this.#flows.get(flowId);
    if (!flow) return undefined;
    const value = code.trim();
    if (!flow.view.needs_code || this.#done(flow) || !value || /\s/.test(value)) {
      if (!value || /\s/.test(value)) flow.view.message = "格式不对：粘贴一整段，不要带空格";
      return { ...flow.view };
    }
    if (flow.view.kind === "api_key") {
      try {
        if (flow.view.agent === "gemini") writeGeminiApiKey(value, this.#env);
        else writeOpencodeApiKey(value, flow.provider ?? "opencode", this.#env);
        this.#finish(flow, "succeeded");
      } catch (error) {
        this.#finish(flow, "failed", error instanceof Error ? error.message : "保存失败");
      }
      return { ...flow.view };
    }
    try {
      flow.child?.write(`${value}\r`);
      flow.view.status = "verifying";
    } catch (error) {
      this.#finish(flow, "failed", error instanceof Error ? error.message : "回填失败");
    }
    return { ...flow.view };
  }

  cancel(flowId: string): AcpLoginFlowView | undefined {
    const flow = this.#flows.get(flowId);
    if (!flow) return undefined;
    if (!this.#done(flow)) this.#finish(flow, "cancelled");
    return { ...flow.view };
  }

  dispose(): void {
    for (const flow of this.#flows.values()) if (!this.#done(flow)) this.#finish(flow, "cancelled");
  }

  #parse(flow: Flow): void {
    if (this.#done(flow)) return;
    const { agent } = flow.view;
    if (agent === "grok" || agent === "codex") {
      const parsed = agent === "grok" ? parseGrokLogin(flow.output) : parseCodexLogin(flow.output);
      if (parsed.url) flow.view.url = parsed.url;
      if (parsed.userCode) flow.view.user_code = parsed.userCode;
      if (flow.view.url && flow.view.status === "starting") flow.view.status = "waiting_for_user";
      return;
    }
    const parsed = parseClaudeSetupToken(flow.output);
    if (parsed.url) flow.view.url = parsed.url;
    if (flow.view.url && flow.view.status === "starting") flow.view.status = "waiting_for_user";
    if (parsed.token) {
      const token = parsed.token;
      // 只在 Mac 本地落盘；输出缓冲里的令牌立刻抹掉，后面的失败说明也不会带上。
      flow.output = flow.output.split(token).join("[已隐藏]");
      void writeClaudeOAuthToken(token, this.#env).then(
        () => this.#finish(flow, "succeeded", `已保存长期令牌（${claudeOAuthTokenPath(this.#env).replace(home(this.#env), "~")}）`),
        (error: unknown) => this.#finish(flow, "failed", error instanceof Error ? error.message : "保存令牌失败"),
      );
      flow.view.status = "verifying";
    }
  }

  #done(flow: Flow): boolean {
    return ["succeeded", "failed", "cancelled"].includes(flow.view.status);
  }

  #finish(flow: Flow, status: "succeeded" | "failed" | "cancelled", message?: string): void {
    if (this.#done(flow)) return;
    flow.view.status = status;
    if (message) flow.view.message = message;
    if (flow.timer) clearTimeout(flow.timer);
    if (flow.child && !flow.exited) flow.child.kill();
  }

  /** 只留最近 20 个流程。 */
  #prune(): void {
    const ids = [...this.#flows.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - 20))) {
      const flow = this.#flows.get(id)!;
      if (this.#done(flow)) this.#flows.delete(id);
    }
  }
}

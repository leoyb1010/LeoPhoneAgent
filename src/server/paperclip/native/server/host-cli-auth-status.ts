import { access, stat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stripServerPrivateEnv } from "@paperclipai/adapter-utils/server-private-env";

export type HostCliAuthStatus = "present" | "absent" | "unknown" | "unsupported";
export interface HostCliAuthStatusResult {
  installed: boolean;
  authStatus: HostCliAuthStatus;
  message: string;
}
interface Profile {
  commands: readonly string[];
  apiEnvKeys: readonly string[];
  statusArgs?: readonly string[];
}
// Inventory only. A configured API key does not establish provider acceptance.
export const HOST_CLI_AUTH_PROFILES: Readonly<Record<string, Profile>> = {
  codex_local: { commands: ["codex"], apiEnvKeys: ["OPENAI_API_KEY", "CODEX_API_KEY"], statusArgs: ["login", "status"] },
  claude_local: { commands: ["claude"], apiEnvKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"], statusArgs: ["auth", "status"] },
  grok_local: { commands: ["grok"], apiEnvKeys: ["XAI_API_KEY", "GROK_API_KEY"] },
  gemini_local: { commands: ["gemini"], apiEnvKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  cursor: { commands: ["cursor-agent", "agent"], apiEnvKeys: ["CURSOR_API_KEY"] },
  cursor_local: { commands: ["cursor-agent", "agent"], apiEnvKeys: ["CURSOR_API_KEY"] },
  kimi_local: { commands: ["kimi"], apiEnvKeys: ["KIMI_MODEL_API_KEY"] },
  opencode_local: { commands: ["opencode"], apiEnvKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] },
  pi_local: { commands: ["pi"], apiEnvKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"] },
  hermes_local: { commands: ["hermes"], apiEnvKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY"] },
};
const TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 64 * 1024;

async function trustedExecutable(profile: Profile, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const command of profile.commands) {
    for (const directory of (env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const file = path.join(directory, command);
      try {
        await access(file, constants.X_OK);
        if (!(await stat(file)).isFile()) continue;
        // The generic "agent" name can belong to Grok; only accept a Cursor installation alias.
        if (command === "agent" && profile.commands.includes("cursor-agent")) {
          const resolved = await realpath(file);
          if (!resolved.split(path.sep).some(part => part === "cursor-agent" || part === ".cursor")) continue;
        }
        return file;
      } catch { /* Try only the next trusted PATH entry. */ }
    }
  }
  return null;
}

/** Resolve only a fixed profile command on the trusted server PATH. */
export async function resolveHostCliExecutable(adapterType: string, trustedEnv: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const profile = Object.hasOwn(HOST_CLI_AUTH_PROFILES, adapterType) ? HOST_CLI_AUTH_PROFILES[adapterType] : undefined;
  return profile ? trustedExecutable(profile, trustedEnv) : null;
}

interface Probe { code: number | null; stdout: string; stderr: string; failed: boolean }
function statusProbe(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Probe> {
  return new Promise(resolve => {
    let done = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // 发行层 1.1.6：第三方 CLI 不继承数据库口令、认证签名密钥等服务器私密变量；PATH/HOME/代理/CLI 配置保留。
    const child = spawn(command, [...args], { env: stripServerPrivateEnv(env, env), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const finish = (code: number | null, failed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, failed, stdout: failed ? "" : Buffer.concat(stdout).toString("utf8"), stderr: failed ? "" : Buffer.concat(stderr).toString("utf8") });
    };
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The bounded probe may already have exited. */ }
      finish(null, true);
    };
    const timer = setTimeout(stop, TIMEOUT_MS);
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) stop();
      else target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => finish(null, true));
    child.once("close", code => finish(code, false));
  });
}

// 发行层 1.1.6：状态接口每次 GET 都会派生 CLI 进程；按（服务器环境对象, 适配器, driver）
// 做 10 秒短缓存并合并并发请求，限制进程数量。缓存只含封闭的状态枚举与固定中文文案。
const STATUS_CACHE_TTL_MS = 10_000;
interface CachedStatus { expiresAt: number; promise: Promise<HostCliAuthStatusResult> }
const statusCache = new WeakMap<NodeJS.ProcessEnv, Map<string, CachedStatus>>();

/** trustedEnv is server state, never adapter/request-supplied env or PATH. */
export async function getHostCliAuthStatus(input: {
  adapterType: string;
  driver: string | null | undefined;
  trustedEnv?: NodeJS.ProcessEnv;
}): Promise<HostCliAuthStatusResult> {
  const env = input.trustedEnv ?? process.env;
  let entries = statusCache.get(env);
  if (!entries) { entries = new Map(); statusCache.set(env, entries); }
  const key = `${input.adapterType}\0${input.driver ?? ""}`;
  const now = Date.now();
  const cached = entries.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = readHostCliAuthStatus(input.adapterType, input.driver, env);
  const entry: CachedStatus = { expiresAt: Number.POSITIVE_INFINITY, promise };
  entries.set(key, entry);
  // 进行中的探测一直合并；完成后才开始计 TTL。异常不缓存。
  promise.then(() => { entry.expiresAt = Date.now() + STATUS_CACHE_TTL_MS; }, () => { if (entries?.get(key) === entry) entries.delete(key); });
  return promise;
}

async function readHostCliAuthStatus(adapterType: string, driver: string | null | undefined, env: NodeJS.ProcessEnv): Promise<HostCliAuthStatusResult> {
  const input = { adapterType, driver };
  const profile = Object.hasOwn(HOST_CLI_AUTH_PROFILES, input.adapterType) ? HOST_CLI_AUTH_PROFILES[input.adapterType] : undefined;
  if (input.driver !== "local" || !profile) {
    return { installed: false, authStatus: "unsupported", message: "仅支持检查本机适配器的 CLI 状态。" };
  }
  const command = await resolveHostCliExecutable(input.adapterType, env);
  if (!command) return { installed: false, authStatus: "absent", message: "服务器尚未安装此提供方的 CLI。" };
  const result = (authStatus: HostCliAuthStatus, message: string): HostCliAuthStatusResult => ({ installed: true, authStatus, message });
  if (profile.statusArgs) {
    const probe = await statusProbe(command, profile.statusArgs, env);
    if (!probe.failed && input.adapterType === "codex_local") {
      const output = `${probe.stdout}\n${probe.stderr}`;
      if (probe.code === 0 && /^Logged in using (?:ChatGPT|an API key)(?:\s|$)/m.test(output)) {
        return result("present", "Codex CLI 已识别现有登录；尚未调用模型验证。");
      }
      if ((probe.code === 0 || probe.code === 1) && /^Not logged in\s*$/m.test(output)) return result("absent", "Codex CLI 尚未登录。");
    }
    if (!probe.failed && input.adapterType === "claude_local") {
      try {
        const status: unknown = JSON.parse(probe.stdout);
        if (status && typeof status === "object" && "loggedIn" in status) {
          if (probe.code === 0 && status.loggedIn === true) return result("present", "Claude CLI 已识别现有登录；尚未调用模型验证。");
          if ((probe.code === 0 || probe.code === 1) && status.loggedIn === false) return result("absent", "Claude CLI 尚未登录。");
        }
      } catch { /* Never reflect malformed output, emails or credential values. */ }
    }
    return result("unknown", "CLI 已安装，暂时无法确认登录状态。");
  }
  const hasApiCredential = profile.apiEnvKeys.some(key => Boolean(env[key]?.trim())) &&
    (input.adapterType !== "kimi_local" || Boolean(env.KIMI_MODEL_NAME?.trim()));
  if (hasApiCredential) return result("unknown", "CLI 已安装，已配置 API 凭据；尚未验证认证是否可用。");
  if (input.adapterType === "grok_local") {
    const home = env.GROK_HOME?.trim() || (env.HOME ? path.join(env.HOME, ".grok") : null);
    if (home) {
      try {
        const auth = await stat(path.join(home, "auth.json"));
        if (auth.isFile() && auth.size > 0) return result("unknown", "Grok CLI 存在凭据文件；尚未验证认证是否可用。");
      } catch { /* No file is not proof of signed-out state on every CLI build. */ }
    }
  }
  return result("unknown", "CLI 已安装；此版本尚无已验证的只读登录状态检查。");
}

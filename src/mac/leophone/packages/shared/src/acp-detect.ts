// [leo][WP-21] ACP 外部 agent 的本机检测（node-only：读 PATH 与文件系统）。
// UI 状态（services）、Leo Link capabilities 与 CLI 启动（adapters/acp）共用同一份判断。
import { execFile, spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { ACP_AGENT_IDS, type AcpAgentId } from "./acp.js";

export const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_AGENT_ACP_VERSION = "0.93.0";
export const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";
export const CODEX_ACP_VERSION = "2.2.2";

export interface AcpLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AcpAgentStatus {
  id: AcpAgentId;
  /** 本机能启动（命令 / 适配器都在）。 */
  available: boolean;
  /** 本机 CLI 的绝对路径（claude / codex / gemini / opencode）；没装为 undefined。 */
  cliPath?: string;
  /** 不可用时给用户看的一句原因。 */
  unavailableReason?: string;
  /** 未登录时在终端里跑的登录命令。 */
  loginCommand?: string;
}

export interface AcpEnvironment {
  env?: NodeJS.ProcessEnv;
  /** 运行 JS 适配器用的 Node（随包 agent 的 process.execPath）。 */
  nodePath?: string;
  /** 测试注入：解析随包 claude-agent-acp 的入口。 */
  resolveClaudeAgentAcpEntry?: () => string | undefined;
}

let loginShellPathCache: string[] | undefined;

/**
 * [fix-remote] 用户登录 shell 的 PATH（只读一次、带超时）。LeoBot 从 Finder / launchd 启动时 PATH 只有
 * /usr/bin 一类系统目录，而 CLI 往往装在 shell 配置里才加进 PATH 的目录（nvm、bun、自定义前缀）。
 * 只对真实进程环境生效：测试注入的 env、VITEST、LEO_ACP_LOGIN_SHELL=off 都不读，结果不随开发机变化。
 */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env !== process.env || process.platform !== "darwin") return [];
  if (process.env.VITEST || process.env.LEO_ACP_LOGIN_SHELL === "off") return [];
  if (loginShellPathCache) return loginShellPathCache;
  const shell = env.SHELL?.trim() || "/bin/zsh";
  try {
    // 交互式 rc 可能往 stdout 打招呼：用标记把 PATH 夹出来。
    const result = spawnSync(shell, ["-lic", "printf '__LEOPATH__%s__LEOPATH__' \"$PATH\""], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /__LEOPATH__(.*?)__LEOPATH__/s.exec(result.stdout ?? "");
    loginShellPathCache = match ? match[1]!.split(delimiter).filter(Boolean) : [];
  } catch {
    loginShellPathCache = [];
  }
  return loginShellPathCache;
}

/** nvm 装的 node 全局包（gemini 等），新版本在前。 */
function nvmBinDirs(home: string): string[] {
  const root = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(root, version, "bin"));
  } catch {
    return [];
  }
}

/** 常见的用户级 / Homebrew 安装目录（不依赖进程 PATH）。 */
export function acpExtraSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".local", "npm-global", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".opencode", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...nvmBinDirs(home),
  ];
}

/**
 * 探测与启动共用的搜索路径：进程 PATH → 登录 shell 的 PATH → 常见安装目录。
 * 启动 agent 时整串写进子进程 PATH：`#!/usr/bin/env node` 一类的 CLI 也要能找到 node。
 */
export function acpSearchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...fromEnv, ...loginShellPath(env), ...acpExtraSearchDirs(env)])];
}

function findExecutableIn(dirs: readonly string[], name: string): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of acpSearchPath(env)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** 随包 claude-agent-acp 的入口：桌面端经 LEO_CLAUDE_AGENT_ACP_ENTRY 传入，开发态从 node_modules 解析。 */
export function resolveClaudeAgentAcpEntry(): string | undefined {
  const override = process.env.LEO_CLAUDE_AGENT_ACP_ENTRY?.trim();
  if (override) return override;
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${CLAUDE_AGENT_ACP_PACKAGE}/package.json`);
    const manifest = require(manifestPath) as { bin?: string | Record<string, string> };
    const bin =
      typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
    return bin ? join(dirname(manifestPath), bin) : undefined;
  } catch {
    return undefined;
  }
}


export function detectAcpAgent(id: AcpAgentId, environment: AcpEnvironment = {}): AcpAgentStatus {
  const env = environment.env ?? process.env;
  switch (id) {
    case "claude-code": {
      // 官方安装器装在 ~/.local/bin；PATH 里可能还躺着旧的 npm 版（实测 2.1.207 与适配器握手后卡住）。
      const home = env.HOME?.trim() || homedir();
      const cliPath =
        findExecutableIn([join(home, ".local", "bin"), join(home, ".claude", "local")], "claude") ??
        findExecutable("claude", env);
      const entry = (environment.resolveClaudeAgentAcpEntry ?? resolveClaudeAgentAcpEntry)();
      // 适配器随包，但 Claude Code 本体用本机安装的 claude（不随包 240MB 的原生二进制）。
      if (!entry) return { id, available: false, unavailableReason: "随包的 Claude Code 适配器缺失" };
      return cliPath
        ? { id, available: true, cliPath, loginCommand: "claude /login" }
        : { id, available: false, unavailableReason: notInstalled("claude") };
    }
    case "codex": {
      const cliPath = findExecutable("codex", env);
      const adapter = findExecutable("codex-acp", env);
      if (!cliPath && !adapter) return { id, available: false, unavailableReason: notInstalled("codex") };
      return { id, available: true, ...(cliPath ? { cliPath } : {}), loginCommand: "codex login" };
    }
    case "gemini": {
      const cliPath = findExecutable("gemini", env);
      return cliPath
        ? { id, available: true, cliPath, loginCommand: "gemini" }
        : { id, available: false, unavailableReason: notInstalled("gemini") };
    }
    case "opencode": {
      const cliPath = findExecutable("opencode", env);
      return cliPath
        ? { id, available: true, cliPath, loginCommand: "opencode auth login" }
        : { id, available: false, unavailableReason: notInstalled("opencode") };
    }
    case "grok": {
      // Grok Build 的安装器放在 ~/.grok/bin（已在搜索路径里）。
      const cliPath = findExecutable("grok", env);
      return cliPath
        ? { id, available: true, cliPath, loginCommand: "grok login" }
        : { id, available: false, unavailableReason: notInstalled("grok") };
    }
  }
}

function notInstalled(command: string): string {
  return `本机没有找到 ${command} 命令（已查 PATH、登录 shell 的 PATH 与 ~/.local/bin、~/.grok/bin、Homebrew、nvm 等常见目录）`;
}

const versionCache = new Map<string, { mtimeMs: number; version: string | undefined }>();

/** [fix-remote] `<cli> --version` 的第一行（带超时；按文件修改时间缓存，升级后自动刷新）。 */
export async function readCliVersion(
  cliPath: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | undefined> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(cliPath)).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = versionCache.get(cliPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  const env = options.env ?? process.env;
  const version = await new Promise<string | undefined>((resolve) => {
    execFile(
      cliPath,
      ["--version"],
      {
        timeout: options.timeoutMs ?? 3000,
        env: { ...env, PATH: acpSearchPath(env).join(delimiter) },
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        const line = `${stdout || ""}\n${stderr || ""}`
          .split("\n")
          .map((item) => item.trim())
          .find(Boolean);
        resolve(error && !stdout ? undefined : line?.slice(0, 120));
      },
    );
  });
  versionCache.set(cliPath, { mtimeMs, version });
  return version;
}

export function detectAcpAgents(environment: AcpEnvironment = {}): AcpAgentStatus[] {
  return ACP_AGENT_IDS.map((id) => detectAcpAgent(id, environment));
}


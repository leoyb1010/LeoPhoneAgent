// [leo][WP-21] ACP 外部 agent 的本机检测（node-only：读 PATH 与文件系统）。
// UI 状态（services）与 CLI 启动（adapters/acp）共用同一份判断。
import { accessSync, constants } from "node:fs";
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

/** 桌面端从 Finder 启动时 PATH 很短：补上常见的用户级安装目录。 */
export function acpSearchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || homedir();
  const fromEnv = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const extras = [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".opencode", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return [...new Set([...fromEnv, ...extras])];
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
        : { id, available: false, unavailableReason: "本机没有安装 Claude Code（claude 命令）" };
    }
    case "codex": {
      const cliPath = findExecutable("codex", env);
      const adapter = findExecutable("codex-acp", env);
      if (!cliPath && !adapter) return { id, available: false, unavailableReason: "本机没有安装 codex" };
      return { id, available: true, ...(cliPath ? { cliPath } : {}), loginCommand: "codex login" };
    }
    case "gemini": {
      const cliPath = findExecutable("gemini", env);
      return cliPath
        ? { id, available: true, cliPath, loginCommand: "gemini" }
        : { id, available: false, unavailableReason: "本机没有安装 gemini" };
    }
    case "opencode": {
      const cliPath = findExecutable("opencode", env);
      return cliPath
        ? { id, available: true, cliPath, loginCommand: "opencode auth login" }
        : { id, available: false, unavailableReason: "本机没有安装 opencode" };
    }
  }
}

export function detectAcpAgents(environment: AcpEnvironment = {}): AcpAgentStatus[] {
  return ACP_AGENT_IDS.map((id) => detectAcpAgent(id, environment));
}


// [leo][WP-21] ACP 外部 agent 的启动命令。检测逻辑与 UI 共用（@zcode/shared/acp-detect）。
import { delimiter } from "node:path";
import type { AcpAgentId } from "@zcode/shared/acp";
import {
  acpSearchPath,
  CODEX_ACP_PACKAGE,
  CODEX_ACP_VERSION,
  detectAcpAgent,
  findExecutable,
  resolveClaudeAgentAcpEntry,
  type AcpEnvironment,
  type AcpLaunchSpec,
} from "@zcode/shared/acp-detect";

export * from "@zcode/shared/acp-detect";
export { ACP_AGENT_IDS, type AcpAgentId } from "@zcode/shared/acp";

function launchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  out.PATH = acpSearchPath(env).join(delimiter);
  return out;
}

/** 解析启动命令；本机条件不满足时返回 undefined（调用方给出可读错误）。 */
export function resolveAcpLaunch(
  id: AcpAgentId,
  environment: AcpEnvironment = {},
): AcpLaunchSpec | undefined {
  const env = environment.env ?? process.env;
  const status = detectAcpAgent(id, environment);
  if (!status.available) return undefined;
  const nodePath = environment.nodePath ?? process.execPath;
  const base = launchEnv(env);
  switch (id) {
    case "claude-code": {
      const entry = (environment.resolveClaudeAgentAcpEntry ?? resolveClaudeAgentAcpEntry)()!;
      return {
        command: nodePath,
        args: [entry],
        // 用本机的 Claude Code（登录态、设置都是用户自己的）。
        env: { ...base, CLAUDE_CODE_EXECUTABLE: status.cliPath! },
      };
    }
    case "codex": {
      const adapter = findExecutable("codex-acp", env);
      if (adapter) {
        return { command: adapter, args: [], env: { ...base, ...(status.cliPath ? { CODEX_PATH: status.cliPath } : {}) } };
      }
      // codex-acp 不随包（体积大）：首次用 npx 拉取钉死版本，CODEX_PATH 指向本机 codex。
      const npx = findExecutable("npx", env);
      if (!npx) return undefined;
      return {
        command: npx,
        args: ["-y", `${CODEX_ACP_PACKAGE}@${CODEX_ACP_VERSION}`],
        env: { ...base, ...(status.cliPath ? { CODEX_PATH: status.cliPath } : {}) },
      };
    }
    case "gemini":
      return { command: status.cliPath!, args: ["--acp"], env: base };
    case "opencode":
      return { command: status.cliPath!, args: ["acp"], env: base };
  }
}

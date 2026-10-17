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
  // 开发自测钩子：LeoBot 跑在隔离 HOME 时，只让外部 agent 子进程回到真实 HOME（它的登录态在那里）。
  const agentHome = env.LEO_ACP_AGENT_HOME?.trim();
  if (agentHome) out.HOME = agentHome;
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
        // 用本机的 Claude Code（登录态、设置都是用户自己的）。nodePath 在桌面端是 Electron 本体，
        // 必须以纯 Node 模式运行，否则会被当成 GUI 进程起 GPU 后崩溃（对真正的 node 无影响）。
        env: { ...base, CLAUDE_CODE_EXECUTABLE: status.cliPath!, ELECTRON_RUN_AS_NODE: "1" },
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
    case "grok":
      // [fix-remote] `grok agent stdio` = ACP over stdio（裸 grok 是 TUI，无终端直接退出）。工作目录由 spawn cwd 与
      // session/new 的 cwd 给出；审批走 session/request_permission（grok 配置里设了 always-approve 时它不会来问）。
      return { command: status.cliPath!, args: ["agent", "stdio"], env: base };
  }
}

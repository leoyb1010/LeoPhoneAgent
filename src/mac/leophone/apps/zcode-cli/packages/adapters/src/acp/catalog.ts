// [leo][WP-21] ACP 外部 agent 的启动命令。检测逻辑与 UI 共用（@zcode/shared/acp-detect）。
import { delimiter } from "node:path";
import type { AcpAgentId } from "@zcode/shared/acp";
import { systemProxyEnabled, withSystemProxy } from "@zcode/shared/system-proxy";
import {
  acpSearchPath,
  CODEX_ACP_PACKAGE,
  ACP_HOST_ENV_KEYS,
  CODEX_ACP_VERSION,
  detectAcpAgent,
  findExecutable,
  geminiAuthPreference,
  geminiEnvFromDotEnv,
  readClaudeOAuthToken,
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
  // [fix-remote] 宿主的 Claude Code 会话变量会让子进程 claude 走错鉴权路径（见 ACP_HOST_ENV_KEYS）。
  for (const key of ACP_HOST_ENV_KEYS) delete out[key];
  out.PATH = acpSearchPath(env).join(delimiter);
  // 开发自测钩子：LeoBot 跑在隔离 HOME 时，只让外部 agent 子进程回到真实 HOME（它的登录态在那里）。
  const agentHome = env.LEO_ACP_AGENT_HOME?.trim();
  if (agentHome) out.HOME = agentHome;
  // [fix-remote] Clash 一类的「系统代理」：GUI 启动的 LeoBot 没有 HTTPS_PROXY，Node / Bun 写的 CLI 不读系统代理会一直挂着。
  const proxied: Record<string, string> = {};
  for (const [key, value] of Object.entries(withSystemProxy(out, { enabled: systemProxyEnabled(env) }))) {
    if (typeof value === "string") proxied[key] = value;
  }
  return proxied;
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
      // [fix-remote] 数据根里有长期令牌就用它（钥匙串登录过期 / 读不到时 claude 报 Authentication required）。
      const token = readClaudeOAuthToken(env);
      return {
        command: nodePath,
        args: [entry],
        // 用本机的 Claude Code（登录态、设置都是用户自己的）。nodePath 在桌面端是 Electron 本体，
        // 必须以纯 Node 模式运行，否则会被当成 GUI 进程起 GPU 后崩溃（对真正的 node 无影响）。
        env: {
          ...base,
          CLAUDE_CODE_EXECUTABLE: status.cliPath!,
          ELECTRON_RUN_AS_NODE: "1",
          ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
        },
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
    case "gemini": {
      // [fix-remote] ~/.gemini/.env 里的 key（env 没有时）；HOME 用子进程实际的 HOME（LEO_ACP_AGENT_HOME 时是它）。
      const env = { ...base, ...geminiEnvFromDotEnv(base) };
      return { command: status.cliPath!, args: ["--acp"], env, authPreference: geminiAuthPreference(env) };
    }
    case "opencode":
      return { command: status.cliPath!, args: ["acp"], env: base };
    case "grok":
      // [fix-remote] `grok agent stdio` = ACP over stdio（裸 grok 是 TUI，无终端直接退出）。工作目录由 spawn cwd 与
      // session/new 的 cwd 给出；审批走 session/request_permission（grok 配置里设了 always-approve 时它不会来问）。
      // grok 只声明一个方法（grok.com）：开会话报 auth_required 时选它，用本机已有的登录。
      return { command: status.cliPath!, args: ["agent", "stdio"], env: base, authPreference: ["grok.com"] };
  }
}

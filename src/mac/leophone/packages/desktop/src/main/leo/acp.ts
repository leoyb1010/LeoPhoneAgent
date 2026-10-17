// [leo][WP-21] 设置「外部 agent」页与新建任务下拉：列出本机可用的 ACP agent，并能在终端里登录。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, ipcMain, shell } from "electron";
import { ACP_COMMANDS_FILE, isAcpAgentId, parseAcpCommandsStore, pickAcpAgentCommands } from "@zcode/shared/acp";
import {
  CLAUDE_AGENT_ACP_PACKAGE,
  resolveClaudeAgentAcpEntry,
  writeClaudeOAuthToken,
} from "@zcode/shared/acp-detect";
import { listAcpAgents } from "@zcode/services/acp-agent";
import { readSystemProxy, setSystemProxyEnabled, systemProxyEnabled } from "@zcode/shared/system-proxy";
import { AcpLoginFlows, acpAuthState, nodePtyLoginSpawner, type NodePtyLike } from "@zcode/shared/acp-login";

/** [fix-remote] 设置页的网页登录（与手机同一套流程，网址在本机浏览器打开）。 */
let localLoginFlows: Promise<AcpLoginFlows> | undefined;
function loginFlows(): Promise<AcpLoginFlows> {
  localLoginFlows ??= import("node-pty")
    .then((pty) => new AcpLoginFlows({ spawnLogin: nodePtyLoginSpawner(pty as unknown as NodePtyLike) }))
    .catch(() => new AcpLoginFlows());
  return localLoginFlows;
}

import { isTrustedLeoSender } from "../leoLinkIpc.js";

/** 打包态在 resources/glm/acp 下；开发态从仓库 node_modules 解析。 */
function claudeAgentAcpEntry(): string | undefined {
  if (app.isPackaged) {
    const entry = join(
      process.resourcesPath,
      "glm",
      "acp",
      "node_modules",
      ...CLAUDE_AGENT_ACP_PACKAGE.split("/"),
      "dist",
      "index.js",
    );
    return existsSync(entry) ? entry : undefined;
  }
  return resolveClaudeAgentAcpEntry();
}

function shellQuoteForAppleScript(command: string): string {
  return command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** CLI 落盘的 agent 自带斜杠命令（见 shared/acp.ts）；数据根与 CLI 同一个 ZCODE_HOME。 */
async function readAcpCommands(agentId: string, cwd: string) {
  const root = process.env["ZCODE_HOME"]?.trim() || join(homedir(), ".leophoneagent");
  try {
    const store = parseAcpCommandsStore(JSON.parse(await readFile(join(root, "cli", ACP_COMMANDS_FILE), "utf8")));
    return pickAcpAgentCommands(store, agentId, cwd);
  } catch {
    return [];
  }
}

export function registerAcpIpc(): void {
  ipcMain.handle("leo:acp:commands", (event, agentId: unknown, cwd: unknown) =>
    isTrustedLeoSender(event) && isAcpAgentId(agentId) && typeof cwd === "string"
      ? readAcpCommands(agentId, cwd)
      : [],
  );
  ipcMain.handle("leo:acp:list", (event) =>
    isTrustedLeoSender(event) ? listAcpAgents({ claudeAgentAcpEntry: claudeAgentAcpEntry() }) : [],
  );
  // [fix-remote] 设置页「粘贴令牌」：Claude Code 长期令牌写进数据根（0600，空串 = 移除）。只回成败，不回内容。
  ipcMain.handle("leo:acp:claude-token", async (event, token: unknown) => {
    if (!isTrustedLeoSender(event) || typeof token !== "string") return { ok: false };
    try {
      await writeClaudeOAuthToken(token);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "保存失败" };
    }
  });
  // [fix-remote] 「外部 agent 使用系统代理」：开关 + 当前系统代理（只给地址，界面用来说明）。
  ipcMain.handle("leo:acp:proxy", (event, enabled: unknown) => {
    if (!isTrustedLeoSender(event)) return { enabled: true, proxy: null };
    if (typeof enabled === "boolean") setSystemProxyEnabled(enabled);
    const proxy = readSystemProxy();
    return { enabled: systemProxyEnabled(), proxy: proxy.https ?? proxy.http ?? proxy.socks ?? null };
  });
  ipcMain.handle(
    "leo:acp:login-flow",
    async (event, action: unknown, agentId: unknown, flowId: unknown, code: unknown) => {
      if (!isTrustedLeoSender(event) || !isAcpAgentId(agentId)) return null;
      const flows = await loginFlows();
      switch (action) {
        case "auth":
          return acpAuthState(agentId);
        case "start":
          return flows.start(agentId);
        case "get":
          return typeof flowId === "string" ? (flows.get(flowId) ?? null) : null;
        case "code":
          return typeof flowId === "string" && typeof code === "string" ? ((await flows.submit(flowId, code)) ?? null) : null;
        case "cancel":
          return typeof flowId === "string" ? (flows.cancel(flowId) ?? null) : null;
        case "open": {
          const url = typeof flowId === "string" ? flows.get(flowId)?.url : undefined;
          if (url?.startsWith("https://")) await shell.openExternal(url);
          return Boolean(url);
        }
        default:
          return null;
      }
    },
  );
  ipcMain.handle("leo:acp:login", async (event, agentId: unknown) => {
    if (!isTrustedLeoSender(event) || !isAcpAgentId(agentId) || process.platform !== "darwin") {
      return { ok: false };
    }
    const agent = listAcpAgents({ claudeAgentAcpEntry: claudeAgentAcpEntry() }).find(
      (candidate) => candidate.id === agentId,
    );
    if (!agent?.cliPath || !agent.loginCommand) return { ok: false };
    // 登录命令只用本机 CLI 自己的流程（浏览器授权 / 交互式），LeoBot 不经手凭据。
    const command = agent.loginCommand.replace(/^\S+/, `"${agent.cliPath}"`);
    const script = `tell application "Terminal"\nactivate\ndo script "${shellQuoteForAppleScript(command)}"\nend tell`;
    return await new Promise<{ ok: boolean }>((resolve) => {
      execFile("/usr/bin/osascript", ["-e", script], (error) => resolve({ ok: !error }));
    });
  });
}

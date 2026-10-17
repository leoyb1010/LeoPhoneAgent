// [leo][WP-21] 设置「外部 agent」页与新建任务下拉：列出本机可用的 ACP agent，并能在终端里登录。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import { ACP_COMMANDS_FILE, isAcpAgentId, parseAcpCommandsStore, pickAcpAgentCommands } from "@zcode/shared/acp";
import { CLAUDE_AGENT_ACP_PACKAGE, resolveClaudeAgentAcpEntry } from "@zcode/shared/acp-detect";
import { listAcpAgents } from "@zcode/services/acp-agent";

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

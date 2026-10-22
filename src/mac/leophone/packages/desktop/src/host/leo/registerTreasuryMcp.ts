import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { IMcpSyncService } from "@zcode/services";

import { registerLeoHttpMcpServer, type LeoMcpLogger } from "./leoHttpMcpRegistration.js";

type Logger = LeoMcpLogger;

const SERVER_NAME = "leo-treasury";

/**
 * [leo] 把藏宝阁登记成用户级 MCP 服务,任何会话都能用 treasury_search / get / save / update,
 * 记忆召回(WP-61)也经它读藏宝阁。
 *
 * [wp-61] 修复原因:以前写 `~/.agents/mcp.json`,但 3.15.1 内核的会话只从 CLI 自己的用户配置
 * (`~/.leophoneagent/cli/config.json` 的 mcp.servers)起 MCP。改走 MCP 同步服务的用户级路径,
 * 设置页里能看到、能停用;用户停用过的保持停用。
 *
 * [up-d-mac] 不再是每个 workspace 一个 stdio 子进程(treasury-mcp.mjs,Electron Helper 当 node 跑,
 * 约 85 MB / 个):登记成 Host 本机接口上的共享 HTTP 端点 `/api/leo/treasury/mcp`,旧 stdio 条目启动时换掉。
 */
export async function registerTreasuryMcpServer(
  sync: Pick<IMcpSyncService, "loadMcpFromUserDirectory" | "saveMcpToUserDirectory">,
  logger: Logger,
): Promise<"registered" | "unchanged" | "failed"> {
  const result = await registerLeoHttpMcpServer(sync, logger, SERVER_NAME, "/api/leo/treasury/mcp");
  if (result !== "failed") removeLegacyAgentsEntry(logger);
  return result;
}

/**
 * 旧版本登记在 `~/.agents/mcp.json` 的同名条目:只删我们自己写的那条(命令参数指向 treasury-mcp.mjs),
 * 否则设置页会出现两条 leo-treasury。文件坏了或条目被用户改成别的就不碰。
 */
export function removeLegacyAgentsEntry(logger: Logger, home: string = homedir()): boolean {
  const configPath = join(home, ".agents", "mcp.json");
  if (!existsSync(configPath)) return false;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, { args?: unknown }>;
    };
    const entry = config.mcpServers?.[SERVER_NAME];
    const args = Array.isArray(entry?.args) ? entry.args : [];
    if (!entry || !args.some((arg) => typeof arg === "string" && arg.endsWith("treasury-mcp.mjs"))) {
      return false;
    }
    delete config.mcpServers![SERVER_NAME];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    logger.info("[leo] removed legacy leo-treasury entry from ~/.agents/mcp.json");
    return true;
  } catch {
    return false;
  }
}

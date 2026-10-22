import type { IMcpSyncService } from "@zcode/services";

import { leoTreasuryKey, LEO_HTTP_PORT } from "./leoPaths.js";

export type LeoMcpLogger = {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
};

type McpSync = Pick<IMcpSyncService, "loadMcpFromUserDirectory" | "saveMcpToUserDirectory">;

/**
 * [up-d-mac] 把 Host 本机 MCP 端点登记进 CLI 用户配置(`~/.leophoneagent/cli/config.json` 的
 * mcp.servers,会话真正读的地方,设置页能看到、能停用):`{type:"http", url, headers}`。
 *
 * - 鉴权用只能开藏宝阁 / 第二大脑端点的藏宝阁钥匙:这份配置所有 agent 都读得到,主钥匙不能出现在这里。
 * - 旧版本登记的 stdio 条目(command + args 指向 Resources/leo/*-mcp.mjs)在这里整条换掉;
 *   CLI 的配置 schema 是 strict 的,http 条目不能夹带 command / args / env。
 * - 用户停用过的保持停用。
 */
export async function registerLeoHttpMcpServer(
  sync: McpSync,
  logger: LeoMcpLogger,
  name: string,
  path: string,
): Promise<"registered" | "unchanged" | "failed"> {
  try {
    const { servers } = await sync.loadMcpFromUserDirectory();
    const existing = servers.find(
      (server) =>
        server.name === name && server.scope === "user" && server.location?.source !== "agents",
    );
    const config = {
      type: "http",
      url: `http://127.0.0.1:${LEO_HTTP_PORT}${path}`,
      headers: { Authorization: `Bearer ${leoTreasuryKey()}` },
    };
    const current = existing?.config;
    const unchanged =
      current !== undefined &&
      current.type === config.type &&
      current.url === config.url &&
      current.command === undefined &&
      JSON.stringify(current.headers ?? {}) === JSON.stringify(config.headers);
    if (unchanged) return "unchanged";
    await sync.saveMcpToUserDirectory({ action: "upsert", source: "zcodeagentmcp", name, config });
    if (existing?.enabled === false) {
      await sync.saveMcpToUserDirectory({
        action: "set-enabled",
        source: "zcodeagentmcp",
        name,
        enabled: false,
      });
    }
    logger.info(`[leo] ${name} mcp registered (host http endpoint)`, {
      migratedFromStdio: current?.command !== undefined,
    });
    return "registered";
  } catch (error) {
    logger.warn(`[leo] ${name} mcp registration failed`, { error: String(error) });
    return "failed";
  }
}

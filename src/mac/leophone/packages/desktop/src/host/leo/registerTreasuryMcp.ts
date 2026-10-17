import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { IMcpSyncService } from "@zcode/services";

import { leoTreasuryKey, LEO_HTTP_PORT } from "./leoPaths.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

const SERVER_NAME = "leo-treasury";

/** 打包态在 Resources/leo 下;开发态在 packages/desktop/leo 下。 */
export function resolveScriptPath(dirname = import.meta.dirname): string {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "leo", "treasury-mcp.mjs") : null,
    // 开发态从打包产物 out/host/index.js 跑;直接跑源码(测试)时在 src/host/leo。
    resolve(dirname, "../../leo/treasury-mcp.mjs"),
    resolve(dirname, "../../../leo/treasury-mcp.mjs"),
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1)!;
}

/**
 * [leo] 把藏宝阁登记成用户级 MCP 服务,任何会话都能用 treasury_search / get / save / update,
 * 记忆召回(WP-61)也经它读藏宝阁。
 *
 * [wp-61] 修复原因:以前写 `~/.agents/mcp.json`,但 3.15.1 内核的会话只从 CLI 自己的用户配置
 * (`~/.leophoneagent/cli/config.json` 的 mcp.servers)起 MCP,桌面也不再把 `.agents` 的条目带进
 * session/create —— 日志里 paramMcpServerCount=0,藏宝阁工具从没进过会话。改走 MCP 同步服务的
 * 用户级路径(与 leo-screen / iMCP 一致),设置页里能看到、能停用;用户停用过的保持停用。
 * 钥匙用只能访问藏宝阁的那把:这份配置所有 agent 都读得到,主钥匙不能出现在这里。
 */
export async function registerTreasuryMcpServer(
  sync: Pick<IMcpSyncService, "loadMcpFromUserDirectory" | "saveMcpToUserDirectory">,
  logger: Logger,
  script: string = resolveScriptPath(),
): Promise<"registered" | "unchanged" | "missing" | "failed"> {
  if (!existsSync(script)) {
    logger.warn("[leo] treasury mcp script missing, skip registration", { script });
    return "missing";
  }
  try {
    const { servers } = await sync.loadMcpFromUserDirectory();
    const existing = servers.find(
      (server) =>
        server.name === SERVER_NAME && server.scope === "user" && server.location?.source !== "agents",
    );
    const env = {
      ...(existing?.config.env as Record<string, string> | undefined),
      ELECTRON_RUN_AS_NODE: "1",
      LEOAGENT_KEY: leoTreasuryKey(),
      LEOAGENT_PORT: String(LEO_HTTP_PORT),
    };
    const args = [script];
    const unchanged =
      existing?.config.command === process.execPath &&
      JSON.stringify(existing.config.args ?? []) === JSON.stringify(args) &&
      JSON.stringify(existing.config.env ?? {}) === JSON.stringify(env);
    if (!unchanged) {
      await sync.saveMcpToUserDirectory({
        action: "upsert",
        source: "zcodeagentmcp",
        name: SERVER_NAME,
        config: { ...existing?.config, command: process.execPath, args, env },
      });
      if (existing?.enabled === false) {
        await sync.saveMcpToUserDirectory({
          action: "set-enabled",
          source: "zcodeagentmcp",
          name: SERVER_NAME,
          enabled: false,
        });
      }
    }
    removeLegacyAgentsEntry(logger);
    if (!unchanged) logger.info("[leo] treasury mcp registered (cli user config)");
    return unchanged ? "unchanged" : "registered";
  } catch (error) {
    logger.warn("[leo] treasury mcp registration failed", { error: String(error) });
    return "failed";
  }
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

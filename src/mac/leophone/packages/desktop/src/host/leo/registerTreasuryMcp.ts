import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { leoLocalKey, LEO_HTTP_PORT } from "./leoPaths.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

const SERVER_NAME = "leo-treasury";

/** 打包态在 Resources/leo 下;开发态在 packages/desktop/leo 下。 */
function resolveScriptPath(): string {
  const packaged = process.resourcesPath
    ? join(process.resourcesPath, "leo", "treasury-mcp.mjs")
    : null;
  if (packaged && existsSync(packaged)) return packaged;
  return resolve(import.meta.dirname, "../../../leo/treasury-mcp.mjs");
}

/**
 * [leo] 把藏宝阁登记成用户级 MCP 服务(`~/.agents/mcp.json`),这样任何会话都能用
 * treasury_search / get / save / update,不用每次手工添加。
 * 已经有同名条目就只更新路径与端口,不动用户改过的其它字段。
 */
export function registerTreasuryMcpServer(logger: Logger): void {
  try {
    const script = resolveScriptPath();
    if (!existsSync(script)) {
      logger.warn("[leo] treasury mcp script missing, skip registration", { script });
      return;
    }
    const configPath = join(homedir(), ".agents", "mcp.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf8")) as typeof config;
      } catch {
        // 用户手改坏了就不要覆盖,直接放弃注册,免得把他的配置冲掉。
        logger.warn("[leo] ~/.agents/mcp.json is not valid JSON, skip registration");
        return;
      }
    }
    const servers = (config.mcpServers ??= {});
    const existing = (servers[SERVER_NAME] as Record<string, unknown> | undefined) ?? {};
    servers[SERVER_NAME] = {
      ...existing,
      command: process.execPath,
      args: [script],
      env: {
        ...(existing["env"] as Record<string, string> | undefined),
        ELECTRON_RUN_AS_NODE: "1",
        LEOAGENT_KEY: leoLocalKey(),
        LEOAGENT_PORT: String(LEO_HTTP_PORT),
      },
    };
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    logger.info("[leo] treasury mcp registered in ~/.agents/mcp.json");
  } catch (error) {
    logger.warn("[leo] treasury mcp registration failed", { error: String(error) });
  }
}

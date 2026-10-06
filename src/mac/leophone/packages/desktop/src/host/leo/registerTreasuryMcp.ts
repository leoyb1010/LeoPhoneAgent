import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
 * [leo] 把藏宝阁登记成用户级 MCP 服务(`~/.agents/mcp.json`),这样任何会话都能用
 * treasury_search / get / save / update,不用每次手工添加。
 * 已经有同名条目就只更新路径与端口,不动用户改过的其它字段。
 * 钥匙用只能访问藏宝阁的那把:这个文件所有 agent 都读得到,主钥匙不能出现在这里。
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
        LEOAGENT_KEY: leoTreasuryKey(),
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

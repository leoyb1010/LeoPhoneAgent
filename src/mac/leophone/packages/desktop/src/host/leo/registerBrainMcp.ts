import { existsSync } from "node:fs";

import type { IMcpSyncService } from "@zcode/services";

import { defaultBrainKeyFile } from "./brainTools.js";
import { registerLeoHttpMcpServer, type LeoMcpLogger } from "./leoHttpMcpRegistration.js";

const SERVER_NAME = "leo-brain";

/**
 * [leo] 把第二大脑登记成用户级 MCP 服务 `leo-brain`(与 leo-treasury 同一路径:CLI 用户配置
 * `~/.leophoneagent/cli/config.json` 的 mcp.servers),任何读这份配置的会话都能用 brain_* 工具。
 *
 * - 只在本机 key 文件存在时登记:没发 key 的 Mac 不能拿到一个每次调用都失败的服务。
 * - [up-d-mac] 服务本体是 Host 本机接口上的共享 HTTP 端点 `/api/leo/brain/mcp`(工具实现见
 *   brainTools.ts),不再是每个 workspace 一个 stdio 子进程(brain-mcp.mjs,约 65 MB / 个)。
 *   第二大脑 key 由 Host 每次请求时读,不进配置;配置里只有藏宝阁钥匙(见 leoHttpMcpRegistration.ts)。
 * - 用户停用过的保持停用;旧 stdio 条目启动时换掉。
 */
export async function registerBrainMcpServer(
  sync: Pick<IMcpSyncService, "loadMcpFromUserDirectory" | "saveMcpToUserDirectory">,
  logger: LeoMcpLogger,
  options: { keyFile?: string } = {},
): Promise<"registered" | "unchanged" | "no-key" | "failed"> {
  const keyFile = options.keyFile ?? defaultBrainKeyFile();
  if (!existsSync(keyFile)) {
    logger.info("[leo] leo-brain key file not provisioned, skip MCP registration");
    return "no-key";
  }
  return registerLeoHttpMcpServer(sync, logger, SERVER_NAME, "/api/leo/brain/mcp");
}

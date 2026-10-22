import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { IMcpSyncService } from "@zcode/services";

type Logger = {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
};

const SERVER_NAME = "leo-brain";

/** 每台 Mac 预先放好的 0600 key 文件;没有就不登记。 */
function defaultBrainKeyFile(home: string = homedir()): string {
  return join(home, ".config", "leo-brain", "leobot-mac.key");
}

/** 打包态在 Resources/leo 下;开发态在 packages/desktop/leo 下。 */
export function resolveBrainScriptPath(dirname = import.meta.dirname): string {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "leo", "brain-mcp.mjs") : null,
    resolve(dirname, "../../leo/brain-mcp.mjs"),
    resolve(dirname, "../../../leo/brain-mcp.mjs"),
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1)!;
}

/**
 * [leo] 把第二大脑登记成用户级 MCP 服务 `leo-brain`(与 leo-treasury 同一路径:CLI 用户配置
 * `~/.leophoneagent/cli/config.json` 的 mcp.servers),任何读这份配置的会话都能用 brain_* 工具。
 *
 * - 只在本机 key 文件存在时登记:没发 key 的 Mac 不能拿到一个每次调用都失败的服务。
 * - env 里只放 key 文件路径,不放 key 本身:这份配置所有 agent 都读得到。
 * - 用户停用过的保持停用;用户在 env 里加的其它项(如 LEO_BRAIN_URL)保留。
 */
export async function registerBrainMcpServer(
  sync: Pick<IMcpSyncService, "loadMcpFromUserDirectory" | "saveMcpToUserDirectory">,
  logger: Logger,
  options: { script?: string; keyFile?: string } = {},
): Promise<"registered" | "unchanged" | "missing" | "no-key" | "failed"> {
  const script = options.script ?? resolveBrainScriptPath();
  const keyFile = options.keyFile ?? defaultBrainKeyFile();
  if (!existsSync(keyFile)) {
    logger.info("[leo] leo-brain key file not provisioned, skip MCP registration");
    return "no-key";
  }
  if (!existsSync(script)) {
    logger.warn("[leo] brain mcp script missing, skip registration", { script });
    return "missing";
  }
  try {
    const { servers } = await sync.loadMcpFromUserDirectory();
    const existing = servers.find(
      (server) =>
        server.name === SERVER_NAME &&
        server.scope === "user" &&
        server.location?.source !== "agents",
    );
    const env = {
      ...(existing?.config.env as Record<string, string> | undefined),
      ELECTRON_RUN_AS_NODE: "1",
      LEO_BRAIN_KEY_FILE: keyFile,
    };
    const args = [script];
    const unchanged =
      existing?.config.command === process.execPath &&
      JSON.stringify(existing.config.args ?? []) === JSON.stringify(args) &&
      JSON.stringify(existing.config.env ?? {}) === JSON.stringify(env);
    if (unchanged) return "unchanged";
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
    logger.info("[leo] brain mcp registered (cli user config)");
    return "registered";
  } catch (error) {
    logger.warn("[leo] brain mcp registration failed", { error: String(error) });
    return "failed";
  }
}

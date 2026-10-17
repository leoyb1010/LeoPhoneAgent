import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { IMcpSyncService } from "@zcode/services";

type Logger = {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
};

/**
 * [leo][WP-22] 把随包的 Peekaboo CLI 登记成 MCP `leo-screen`(`peekaboo mcp`,stdio),agent 用它的
 * see / click / type / press / scroll / menu / app / window 等工具看屏、操作 Mac。
 *
 * 写入走 MCP 同步服务的用户级路径(与设置页「新建」、iMCP 一键添加相同:~/.leophoneagent/cli/config.json
 * 的 mcp.servers),设置页里能看到、能停用。已登记且路径一致就不写;用户停用过(enabled:false)保持停用。
 * 二进制不在(开发态没跑 scripts/leo-fetch-peekaboo.mjs)就跳过,只记一条 warn。
 */
const PEEKABOO_MCP_NAME = "leo-screen";

/** 打包态在 Resources/leo/bin;开发态在 packages/desktop/leo/bin(从 out/host 或 src/host/leo 解析)。 */
export function resolvePeekabooPath(
  dirname = import.meta.dirname,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "leo", "bin", "peekaboo") : null,
    resolve(dirname, "../../leo/bin/peekaboo"),
    resolve(dirname, "../../../leo/bin/peekaboo"),
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export async function registerPeekabooMcpServer(
  sync: Pick<IMcpSyncService, "loadMcpFromUserDirectory" | "saveMcpToUserDirectory">,
  logger: Logger,
  binaryPath: string | null = resolvePeekabooPath(),
): Promise<"registered" | "unchanged" | "missing" | "failed"> {
  if (!binaryPath) {
    logger.warn(
      "[leo] peekaboo binary missing, skip leo-screen MCP (run scripts/leo-fetch-peekaboo.mjs)",
    );
    return "missing";
  }
  try {
    const { servers } = await sync.loadMcpFromUserDirectory();
    const existing = servers.find(
      (server) => server.name === PEEKABOO_MCP_NAME && server.scope === "user",
    );
    const args = ["mcp"];
    if (
      existing?.config.command === binaryPath &&
      JSON.stringify(existing.config.args ?? []) === JSON.stringify(args)
    ) {
      return "unchanged";
    }
    // App 挪了位置(或升级后路径变了)只更新命令与参数,用户在设置里改过的其它字段保留。
    await sync.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: PEEKABOO_MCP_NAME,
      config: { ...existing?.config, command: binaryPath, args },
    });
    // upsert 会重写整条配置;用户停用过的保持停用。
    if (existing?.enabled === false) {
      await sync.saveMcpToUserDirectory({
        action: "set-enabled",
        source: "zcodeagentmcp",
        name: PEEKABOO_MCP_NAME,
        enabled: false,
      });
    }
    logger.info("[leo] leo-screen (peekaboo) MCP registered");
    return "registered";
  } catch (error) {
    logger.warn("[leo] leo-screen MCP registration failed", { error: String(error) });
    return "failed";
  }
}

import { existsSync } from "node:fs";

/**
 * [leo] iMCP(mattt/iMCP,MIT)一键登记(WP-25)。iMCP 是菜单栏 App,自己持有日历/提醒/通讯录/信息等 TCC 授权,
 * 随 App 带一个 stdio 小程序 imcp-server,经 Bonjour 连回 App。我们不随包、不替用户安装,只检测并把它登记成 MCP。
 * 登记本身由设置页走「添加 MCP」同一条写入路径(用户级 ~/.leophoneagent/cli/config.json 的 mcp.servers;
 * agent 同时读它和 ~/.agents/mcp.json),列表即时刷新。
 */

const IMCP_SERVER_NAME = "imcp";
const IMCP_APP_PATH = "/Applications/iMCP.app";
export const IMCP_SERVER_PATH = `${IMCP_APP_PATH}/Contents/MacOS/imcp-server`;
export const IMCP_INSTALL_COMMAND = "brew install --cask mattt/tap/iMCP";

type ImcpStatus =
  | { platform: "darwin"; installed: true; serverName: string; config: { command: string } }
  | { platform: "darwin"; installed: false; installCommand: string; appFound: boolean }
  | { platform: "other" };

export function detectImcp(
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): ImcpStatus {
  if (platform !== "darwin") return { platform: "other" };
  if (exists(IMCP_SERVER_PATH)) {
    return {
      platform: "darwin",
      installed: true,
      serverName: IMCP_SERVER_NAME,
      config: { command: IMCP_SERVER_PATH },
    };
  }
  // App 在但 shim 不在:多半是太旧的版本(1.x 之前没有 imcp-server),按未安装处理,给升级命令。
  return {
    platform: "darwin",
    installed: false,
    installCommand: IMCP_INSTALL_COMMAND,
    appFound: exists(IMCP_APP_PATH),
  };
}

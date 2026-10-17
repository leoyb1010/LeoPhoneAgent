import { ipcMain } from "electron";

import { isTrustedLeoSender } from "../leoLinkIpc.js";
import { detectImcp } from "./imcpCore.js";

/** [leo] 设置 → 扩展 → MCP 的「推荐：iMCP」卡片查询本机是否装了 iMCP(见 imcpCore.ts)。 */
export function registerImcpIpc(): void {
  ipcMain.handle("leo:imcp:status", (event) =>
    isTrustedLeoSender(event) ? detectImcp() : { platform: "other" },
  );
}

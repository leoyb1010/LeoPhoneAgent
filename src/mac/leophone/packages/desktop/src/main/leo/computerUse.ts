import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, ipcMain, shell } from "electron";

import { isTrustedLeoSender } from "../leoLinkIpc.js";
import {
  parsePeekabooPermissions,
  PRIVACY_PANE_URL,
  type ComputerUsePermissionKey,
  type ComputerUseStatus,
} from "./computerUseCore.js";

/** [leo][WP-22] 设置「电脑操作」:查随包 Peekaboo 的权限状态、跳系统设置对应面板。 */

function peekabooPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "leo", "bin", "peekaboo")
    : join(import.meta.dirname, "../../leo/bin/peekaboo");
}

function run(binary: string, args: string[]): Promise<{ stdout: string; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve({ stdout: String(stdout), error }),
    );
  });
}

async function readStatus(): Promise<ComputerUseStatus> {
  const binary = peekabooPath();
  if (!existsSync(binary)) return { state: "missing" };
  const [permissions, version] = await Promise.all([
    run(binary, ["permissions", "status", "--json"]),
    run(binary, ["--version"]),
  ]);
  // 权限不全时 Peekaboo 也可能非 0 退出,但 stdout 里仍是完整 JSON:以 JSON 为准。
  const status = parsePeekabooPermissions(permissions.stdout);
  if (status.state === "error" && permissions.error) {
    return { state: "error", message: permissions.error.message };
  }
  return status.state === "ok"
    ? { ...status, version: /Peekaboo\s+(\S+)/.exec(version.stdout)?.[1] ?? null }
    : status;
}

export function registerComputerUseIpc(): void {
  if (process.platform !== "darwin") return;
  ipcMain.handle("leo:computer-use:status", (event) =>
    isTrustedLeoSender(event) ? readStatus() : { state: "error", message: "forbidden" },
  );
  ipcMain.handle("leo:computer-use:open-settings", async (event, key: unknown) => {
    if (!isTrustedLeoSender(event)) return false;
    const url = PRIVACY_PANE_URL[key as ComputerUsePermissionKey];
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });
  // [up-mac] 屏幕录制等权限在系统设置里打开后，macOS 要求 App 重启才认；给设置页一个一键重启。
  ipcMain.handle("leo:computer-use:relaunch", (event) => {
    if (!isTrustedLeoSender(event)) return false;
    app.relaunch();
    app.quit();
    return true;
  });
}

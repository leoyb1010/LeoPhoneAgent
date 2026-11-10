import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { shell } from "electron";
import { resolveExternalOpenTarget } from "./externalFileOpenPolicy.js";

type DesktopIpcLogger = {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export async function openFileUrlInDefaultApp(
  url: string,
  logger: DesktopIpcLogger,
): Promise<void> {
  try {
    const filePath = fileURLToPath(url);
    await openPathInDefaultApp(filePath, logger);
  } catch (error) {
    logger.warn("[open-external] file URL 打开失败", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function openPathInDefaultApp(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    const error = "empty path";
    logger.warn("[open-external] 本地文件打开失败", { path: rawPath, error });
    return { success: false, error };
  }

  // [leo] 根因：原先 realpath 失败仍拿原路径打开，且不看文件类型，.app / .command / .pkg 会被直接启动。
  // 现在按真实目标判定：解析不了就不打开；可启动类型改为在访达里显示（docs/specs/desktop-renderer-boundary.md §2）。
  const target = await resolveExternalOpenTarget(trimmed);
  if (target.kind === "missing") {
    logger.warn("[open-external] 本地文件不存在或无法解析，不打开", { path: target.requested });
    return { success: false, error: "path_not_found" };
  }
  if (target.kind === "reveal") {
    logger.warn("[open-external] 可执行 / 应用 / 安装包类文件不直接打开，改为在访达中显示", {
      path: target.path,
    });
    shell.showItemInFolder(target.path);
    return { success: true };
  }

  try {
    const error = await shell.openPath(target.path);
    if (error) {
      logger.warn("[open-external] 本地文件打开失败", { path: target.path, error });
      return { success: false, error };
    }
    logger.info?.("[open-external] 本地文件打开成功", { path: target.path });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[open-external] 本地文件打开失败", { path: target.path, error: message });
    return { success: false, error: message };
  }
}

export async function openPathInFileManager(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return { success: false, error: "empty path" };
  }
  // [leo] 根因同 openPathInDefaultApp：「在文件管理器中打开」对 .app 包目录或可执行文件调 open / openPath
  // 会直接启动它们。解析失败不再继续；可启动目标和普通文件都在访达里选中显示，只有普通目录才打开。
  const target = await resolveExternalOpenTarget(trimmed);
  if (target.kind === "missing") {
    logger.warn("[open-in-file-manager] 路径不存在或无法解析，不打开", { path: target.requested });
    return { success: false, error: "path_not_found" };
  }
  if (target.kind === "reveal" || !target.isDirectory) {
    shell.showItemInFolder(target.path);
    return { success: true };
  }

  if (process.platform === "darwin") {
    return openDarwinPathInFileManager(target.path, logger);
  }

  const error = await shell.openPath(target.path);
  if (error) {
    logger.warn("[open-in-file-manager] shell.openPath 失败", {
      path: target.path,
      error,
    });
    return { success: false, error };
  }
  return { success: true };
}

export async function captureWindowScreenshot(senderWindow: BrowserWindow | null) {
  if (!senderWindow || senderWindow.isDestroyed()) {
    return null;
  }

  // 报错横幅里的反馈需要带上用户看到的现场。
  // 这里在 main 进程截当前窗口，避免 renderer 走屏幕录制权限或只能截到局部 DOM。
  const image = await senderWindow.webContents.capturePage();
  const buffer = image.toPNG();
  return {
    dataBase64: buffer.toString("base64"),
    filename: `zcode-error-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    contentType: "image/png",
    size: buffer.byteLength,
  };
}

async function openDarwinPathInFileManager(target: string, logger: DesktopIpcLogger) {
  const runOpen = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile("open", args, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await runOpen([target]);
    return { success: true };
  } catch (firstError) {
    try {
      await runOpen(["-a", "Finder", target]);
      return { success: true };
    } catch (finderError) {
      const shellMessage = await shell.openPath(target);
      if (!shellMessage) {
        return { success: true };
      }
      logger.warn("[open-in-file-manager] macOS 打开目录均失败", {
        path: target,
        shellMessage,
        firstError: firstError instanceof Error ? firstError.message : String(firstError),
        finderError: finderError instanceof Error ? finderError.message : String(finderError),
      });
      return { success: false, error: shellMessage };
    }
  }
}

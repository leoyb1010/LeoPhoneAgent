import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { shell } from "electron";
import type { OpenInEditorOptions, OpenInEditorRemoteTarget } from "@zcode/shared";
import { getEditorDefsForCurrentPlatform, resolveEditorDefAppPath } from "./editors.js";
import { logger } from "./logger.js";

type PathKind = "file" | "directory" | "unknown";

interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

const VSCODE_EDITOR_IDS = new Set(["vscode", "vscode-insiders"]);

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const execFileAsync = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error) => (error ? reject(error) : resolve()));
  });

async function openPathViaShell(path: string): Promise<OpenInEditorResult> {
  const error = await shell.openPath(path);
  return error ? { success: false, error } : { success: true };
}

function detectPathKind(path: string): PathKind {
  try {
    const stats = statSync(path);
    if (stats.isFile()) {
      return "file";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
  } catch {
    // 非本地路径或路径不存在时保留 unknown，交给后续 fallback 处理。
  }
  return "unknown";
}

function isVSCodeEditor(editorId: string): boolean {
  return VSCODE_EDITOR_IDS.has(editorId);
}

function normalizeRemotePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function encodeRemotePath(path: string): string {
  return normalizeRemotePath(path)
    .split("/")
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
}

function resolveVSCodeSshRemoteAuthority(
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
): string {
  const sshConfigAlias = target.sshConfigAlias?.trim();
  if (sshConfigAlias) {
    return sshConfigAlias;
  }

  const username = target.username.trim();
  const host = target.host.trim();
  const userHost = username ? `${username}@${host}` : host;
  return target.port && target.port !== 22 ? `${userHost}:${target.port}` : userHost;
}

function buildVSCodeSshFolderUri(
  path: string,
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
) {
  // 手填 SSH 目标没有 alias 时，authority 里可能包含 `@` 和 `:`。
  // 直接拼进 URI 会被解析成 userinfo/host/port，必须按 Remote-SSH authority 组件整体编码。
  const encodedAuthority = encodeURIComponent(resolveVSCodeSshRemoteAuthority(target));
  return `vscode-remote://ssh-remote+${encodedAuthority}${encodeRemotePath(path)}`;
}

async function openVSCodeRemoteSshFolder(
  editorId: string,
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  // 远程文件和目录以前共用 folder URI，导致文件路径被 VS Code 当成目录；
  // pathKind 只决定 CLI URI 参数，远端路径与 workspace identity 保持原样。
  const args = [
    pathKind === "file" ? "--file-uri" : "--folder-uri",
    buildVSCodeSshFolderUri(path, remoteTarget),
  ];

  if (command) {
    try {
      await execFileAsync(command, args);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, args, error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, "--args", ...args]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] 打开 VS Code 远程工作区失败", {
          editorId,
          path,
          args,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, args);
    } else {
      await execFileAsync("open", ["-a", appPath, "--args", ...args]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开 VS Code 远程工作区失败", {
      editorId,
      path,
      args,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}

async function openWindowsEditor(
  editorId: string,
  appPath: string,
  args: string[],
  cliError?: unknown,
): Promise<OpenInEditorResult> {
  try {
    await execFileAsync(appPath, args);
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开 Windows 编辑器失败", {
      editorId,
      args,
      appPath,
      error: stringifyError(error),
      cliError: cliError === undefined ? undefined : stringifyError(cliError),
    });
    return { success: false, error: stringifyError(error) };
  }
}

/**
 * 用指定编辑器打开路径。
 */
export async function openInEditor(
  editorId: string,
  path: string,
  options?: OpenInEditorOptions,
): Promise<OpenInEditorResult> {
  const def = getEditorDefsForCurrentPlatform().find((editor) => editor.id === editorId);
  if (!def) {
    return { success: false, error: `unknown editor: ${editorId}` };
  }

  const appPath = resolveEditorDefAppPath(def) ?? def.appPath;
  if (options?.remoteTarget?.kind === "ssh" && isVSCodeEditor(editorId)) {
    // SSH 工作区的 workspacePath 是远端文件系统路径，不能按本机路径执行 `code /root/...`。
    // VS Code Remote-SSH 需要 folder URI 才会连接对应 SSH Host 并打开远端目录。
    return openVSCodeRemoteSshFolder(
      editorId,
      appPath,
      def.command,
      path,
      options.remoteTarget,
      options.pathKind,
    );
  }

  const pathKind = detectPathKind(path);

  if (editorId === "finder") {
    if (pathKind === "file") {
      shell.showItemInFolder(path);
      return { success: true };
    }
    return openPathViaShell(path);
  }

  if (editorId === "explorer") {
    if (pathKind !== "file") {
      return openPathViaShell(path);
    }

    // Explorer 已委托打开请求后仍可能非零退出，按退出码回退会重复打开窗口。
    // 本地文件直接使用系统定位 API，只发出一次打开所在目录并选中文件的请求。
    shell.showItemInFolder(path);
    return { success: true };
  }

  if (def.command) {
    try {
      await execFileAsync(def.command, [path]);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, [path], error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, path]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] 打开编辑器失败", {
          editorId,
          path,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, [path]);
    } else {
      await execFileAsync("open", ["-a", appPath, path]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开编辑器失败", {
      editorId,
      path,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}

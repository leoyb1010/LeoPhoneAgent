import type { BrowserWindow } from "electron";
import type { ExternalWorkspaceOpenDialogCopy } from "./desktopOAuthDeepLink.js";
import {
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
  extractOpenWorkspacePathFromArgs,
  extractOpenWorkspacePathFromSingleInstanceData,
} from "./desktopDeepLinkUrl.js";

interface SecondInstanceWorkspaceDeps {
  additionalData: unknown;
  argv: readonly string[];
  handleDeepLink: (
    url: string,
    options: {
      canOpenWorkspace?: () => boolean;
      confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
      onWorkspaceOpenBlocked?: () => void;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  handleOpenWorkspacePath: (
    path: string,
    options?: {
      allowWithoutReadyWindow?: boolean;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  logger: { warn: (...args: unknown[]) => void };
  workspaceConfirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export function handleSecondInstanceWorkspaceRequest(deps: SecondInstanceWorkspaceDeps): boolean {
  const url =
    // Linux 的 second-instance argv 可能被桌面环境重排或追加参数。
    // Electron 官方建议精确参数走 additionalData，这里优先读取第二实例预解析出的 deep link。
    extractDeepLinkUrlFromSingleInstanceData(deps.additionalData) ??
    extractDeepLinkUrlFromArgs(deps.argv);
  if (
    url &&
    deps.handleDeepLink(url, {
      confirmationCopy: deps.workspaceConfirmationCopy,
      resolveApplicationWindow: deps.resolveApplicationWindow,
    })
  ) {
    return true;
  }

  const openWorkspacePath =
    extractOpenWorkspacePathFromSingleInstanceData(deps.additionalData) ??
    extractOpenWorkspacePathFromArgs(deps.argv);
  return Boolean(
    openWorkspacePath &&
    deps.handleOpenWorkspacePath(openWorkspacePath, {
      resolveApplicationWindow: deps.resolveApplicationWindow,
    }),
  );
}

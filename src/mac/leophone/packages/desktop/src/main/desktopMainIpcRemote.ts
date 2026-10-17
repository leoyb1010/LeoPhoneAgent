/* eslint-disable max-lines -- OAuth 回调、外链、遥测和通知 IPC 共用窗口级上下文，集中注册避免跨文件状态漂移。 */
// [leo] SSH / WSL / Docker / server 远程工作区已删除，本文件只保留通用 IPC。
import { app, ipcMain, shell } from "electron";
import armsRum from "@arms/rum-electron";
import {
  armsCustomEventPayloadSchema,
  formatZodError,
  normalizeUnknownError,
  PlatformChannels,
  rendererTelemetryEventPayloadSchema,
  type ArmsRumEnv,
} from "@zcode/shared";
import { dispatchTaskNotification } from "./desktopNotifications.js";
import {
  clearOAuthRoutesForWindow,
  deliverPendingDeepLink,
  parseOAuthStateRegistration,
  registerOAuthState,
} from "./desktopOAuthDeepLink.js";
import {
  dispatchFinalArmsCustomEvent,
  enableSharedFinalArmsCustomEventE2EController,
} from "./desktopArmsCustomEvent.js";
import { openFileUrlInDefaultApp, openPathInDefaultApp } from "./desktopMainIpcHelpers.js";
import { isAllowedExternalOpenUrl } from "./mainWindowNavigationPolicy.js";

// 上游测试与调用方从这里取该判定；规则本体在 mainWindowNavigationPolicy（[leo] webview 访客只能开 http(s)）。
export { isAllowedExternalOpenUrl };

interface OpenExternalRequest {
  sourceUrl?: string;
  url: string;
}

function parseOpenExternalRequest(payload: unknown): OpenExternalRequest | null {
  if (typeof payload === "string") {
    return { url: payload };
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    url: record.url,
  };
}

export function registerRemoteIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  appTelemetryRuntime: {
    onRendererReady(payload: { hasPendingOAuthCallback: boolean; rendererId: number }): void;
    syncRendererContext(payload: { rendererId: number; context: unknown }): void;
    onOAuthCallbackHandled(payload: { rendererId: number }): void;
  };
  /** OAuth 回调处理完成后的额外副作用（如刷新 ARMS user.id）；不影响既有 runtime 流程 */
  onOAuthCallbackHandledSideEffect?: () => void;
  appTelemetryCore: {
    reportEvent(payload: unknown): Promise<void>;
  };
  armsCustomContext: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
  };
  /** 仅由 VITE_ZCODE_E2E_STORE_BRIDGE + test runner 双门禁打开。 */
  finalArmsCustomEventE2EEnabled?: boolean;
}) {
  const finalArmsCustomEventE2E = options.finalArmsCustomEventE2EEnabled
    ? enableSharedFinalArmsCustomEventE2EController()
    : null;

  if (finalArmsCustomEventE2E) {
    ipcMain.handle(PlatformChannels.ReadFinalArmsCustomEventsE2E, () =>
      finalArmsCustomEventE2E.read(),
    );
    ipcMain.handle(PlatformChannels.ClearFinalArmsCustomEventsE2E, () => {
      finalArmsCustomEventE2E.clear();
    });
    ipcMain.handle(
      PlatformChannels.ConfigureFinalArmsCustomEventsE2E,
      (_event, request: unknown) => {
        finalArmsCustomEventE2E.configure(
          request as Parameters<typeof finalArmsCustomEventE2E.configure>[0],
        );
      },
    );
  }

  ipcMain.on(PlatformChannels.OAuthRegisterState, (event, payload: unknown) => {
    const registration = parseOAuthStateRegistration(payload);
    if (!registration) {
      options.logger.warn("[oauth-register-state] invalid payload", payload);
      return;
    }

    registerOAuthState(event.sender.id, registration);
  });

  ipcMain.on(PlatformChannels.OpenExternal, (event, payload: unknown) => {
    const request = parseOpenExternalRequest(payload);
    if (!request) {
      options.logger.warn("[open-external] blocked unsupported request", payload);
      return;
    }
    const { url } = request;
    const fromWebviewGuest =
      typeof event.sender?.getType === "function" && event.sender.getType() === "webview";
    if (!isAllowedExternalOpenUrl(url, fromWebviewGuest)) {
      options.logger.warn("[open-external] blocked unsupported url", url);
      return;
    }
    // 3.15.1：file: 交给默认应用打开（openPath 语义），不走 shell.openExternal，避免直接启动 .app / .command。
    if (new URL(url).protocol === "file:") {
      void openFileUrlInDefaultApp(url, options.logger);
      return;
    }
    void Promise.resolve(shell.openExternal(url)).catch((error: unknown) => {
      options.logger.warn("[open-external] 外部 URL 打开失败", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    openPathInDefaultApp(rawPath, options.logger),
  );

  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    const hasPendingOAuthCallback = deliverPendingDeepLink(event.sender);
    options.appTelemetryRuntime.onRendererReady({
      hasPendingOAuthCallback,
      rendererId: event.sender.id,
    });
  });

  ipcMain.on(PlatformChannels.SyncTelemetryContext, (event, context) => {
    options.appTelemetryRuntime.syncRendererContext({
      rendererId: event.sender.id,
      context,
    });
  });

  ipcMain.handle(PlatformChannels.ReportTelemetryEvent, async (_event, payload: unknown) => {
    const result = rendererTelemetryEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-telemetry-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    await options.appTelemetryCore.reportEvent(result.data);
  });

  ipcMain.handle(PlatformChannels.ReportArmsCustomEvent, async (event, payload: unknown) => {
    const result = armsCustomEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-arms-custom-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    try {
      dispatchFinalArmsCustomEvent({
        payload: result.data,
        context: {
          ...options.armsCustomContext,
          rendererId: event.sender.id,
        },
        e2eController: finalArmsCustomEventE2E,
        // FinalArmsCustomEventPayload 是 SDK RumCustomEvent 的收窄子集；SDK 额外要求
        // BaseObject 索引签名，但这里不会动态追加未声明字段。
        sendCustom: (payload) =>
          armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
      });
    } catch (error) {
      options.logger.warn(
        "[report-arms-custom-event] sendCustom failed:",
        normalizeUnknownError(error).message,
      );
    }
  });

  ipcMain.on(PlatformChannels.OAuthCallbackHandled, (event) => {
    options.appTelemetryRuntime.onOAuthCallbackHandled({ rendererId: event.sender.id });
    options.onOAuthCallbackHandledSideEffect?.();
  });

  ipcMain.on(PlatformChannels.ShowTaskNotification, (event, payload: unknown) => {
    dispatchTaskNotification({ event, payload, logger: options.logger });
  });
  ipcMain.handle(PlatformChannels.ShowTaskNotification, (event, payload: unknown) =>
    dispatchTaskNotification({ event, payload, logger: options.logger }),
  );

  app.on("browser-window-created", (_, win) => {
    const windowWebContentsId = win.webContents.id;
    win.on("closed", () => {
      // BrowserWindow 的 closed 阶段里 webContents 可能已被 Electron 释放。
      // 之前这里直接读取 win.webContents.id，会把正常关窗流程变成主进程未捕获异常。
      // 提前缓存 id 后再做清理，避免访问已经销毁的对象。
      clearOAuthRoutesForWindow(windowWebContentsId);
    });
  });
}

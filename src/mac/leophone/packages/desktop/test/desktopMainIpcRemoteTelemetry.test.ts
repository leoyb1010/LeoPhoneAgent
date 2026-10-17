import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";
import { isAllowedExternalOpenUrl } from "../src/main/desktopMainIpcRemote.js";

type IpcHandler = (...args: unknown[]) => unknown;
type RemoteIpcOptions = Parameters<
  typeof import("../src/main/desktopMainIpcRemote.js").registerRemoteIpcHandlers
>[0];

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  registerWebRemoteControlIpcHandlers: vi.fn(),
  shellOpenExternal: vi.fn(),
  shellOpenPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: h.fromWebContents,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => h.listeners.set(channel, handler)),
  },
  shell: {
    openExternal: h.shellOpenExternal,
    openPath: h.shellOpenPath,
  },
}));

vi.mock("../src/main/desktopNotifications.js", () => ({
  dispatchTaskNotification: vi.fn(),
}));

vi.mock("../src/main/desktopOAuthDeepLink.js", () => ({
  clearOAuthRoutesForWindow: vi.fn(),
  deliverPendingDeepLink: vi.fn(() => false),
  parseOAuthStateRegistration: vi.fn(),
  registerOAuthState: vi.fn(),
}));

vi.mock("../src/main/desktopArmsCustomEvent.js", () => ({
  createFinalArmsCustomEventE2EController: vi.fn(),
  dispatchFinalArmsCustomEvent: vi.fn(),
}));

vi.mock("../src/main/desktopWebRemoteControlIpc.js", () => ({
  registerWebRemoteControlIpcHandlers: h.registerWebRemoteControlIpcHandlers,
}));

function createOptions(overrides?: Partial<RemoteIpcOptions>): RemoteIpcOptions {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    appTelemetryRuntime: {
      onRendererReady: vi.fn(),
      syncRendererContext: vi.fn(),
      onOAuthCallbackHandled: vi.fn(),
    },
    appTelemetryCore: {
      reportEvent: vi.fn(async () => {}),
    },
    armsCustomContext: {
      deviceMid: "device-mid",
      platform: "darwin",
      appVersion: "1.0.0",
      armsEnv: "test",
    },
    webRemoteControlManager: {
      authorizeStart: vi.fn(),
      startAuthorized: vi.fn(),
      resetPairingAuthorized: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(),
    },
    ...overrides,
  };
}

describe("desktop main IPC openExternal", () => {
  it("只允许 Web URL 和 file URL 交给系统浏览器", () => {
    expect(isAllowedExternalOpenUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalOpenUrl("file:///tmp/report.html")).toBe(true);
    expect(isAllowedExternalOpenUrl("file:///tmp/report.txt")).toBe(true);
    expect(isAllowedExternalOpenUrl("file:///etc/passwd")).toBe(true);
    expect(isAllowedExternalOpenUrl("data:text/html,hello")).toBe(false);
  });

  beforeEach(() => {
    h.handlers.clear();
    h.listeners.clear();
    h.fromWebContents.mockReset();
    h.fromWebContents.mockReturnValue({ id: 17 });
    h.registerWebRemoteControlIpcHandlers.mockReset();
    h.shellOpenExternal.mockReset().mockResolvedValue(undefined);
    h.shellOpenPath.mockReset().mockResolvedValue("");
  });

  it("只允许 main 进程打开 http/https/file URL", async () => {
    const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
    const options = createOptions();
    registerRemoteIpcHandlers(options);
    const listener = h.listeners.get(PlatformChannels.OpenExternal);
    expect(listener).toBeDefined();

    listener?.({}, "https://example.com/docs");
    listener?.({}, "http://localhost:3000/index.html");
    listener?.({}, "file:///tmp/secret");
    listener?.({}, "javascript:alert(1)");
    listener?.({}, "not a url");

    expect(h.shellOpenExternal).toHaveBeenCalledTimes(2);
    expect(h.shellOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(h.shellOpenExternal).toHaveBeenCalledWith("http://localhost:3000/index.html");
    await vi.waitFor(() => expect(h.shellOpenPath).toHaveBeenCalledWith("/tmp/secret"));
    expect(options.logger.warn).toHaveBeenCalledTimes(2);
  });

  // [leo] 官网购买页（Coding Plan / PayPal）webview 不接线
  it.skip("keeps Coding Plan PayPal callback openExternal requests in the sender webview", async () => {
    const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
    const options = createOptions();
    registerRemoteIpcHandlers(options);
    const listener = h.listeners.get(PlatformChannels.OpenExternal);
    expect(listener).toBeDefined();

    const sender = {
      getURL: vi.fn(() => "https://www.sandbox.paypal.com/agreements/approve"),
      loadURL: vi.fn(() => Promise.resolve()),
    };
    const returnTo = encodeURIComponent(
      "/coding-plan?provider=zai&embedded=app&lang=cn&theme=zai-dark",
    );
    const callbackUrl = `http://localhost:3000/coding-plan/payment/callback?channel=paypal&status=return&returnTo=${returnTo}&approval_token_id=setup-1`;
    listener?.({ sender }, callbackUrl);

    expect(sender.loadURL).toHaveBeenCalledWith(callbackUrl);
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  // [leo] 官网购买页（Coding Plan / PayPal）webview 不接线
  it.skip("uses Coding Plan bridge sourceUrl when routing openExternal callbacks", async () => {
    const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
    const options = createOptions();
    registerRemoteIpcHandlers(options);
    const listener = h.listeners.get(PlatformChannels.OpenExternal);
    expect(listener).toBeDefined();

    const sender = {
      getURL: vi.fn(() => "file:///Applications/ZCode/index.html"),
      loadURL: vi.fn(() => Promise.resolve()),
    };
    const returnTo = encodeURIComponent(
      "/coding-plan?provider=zai&embedded=app&lang=cn&theme=zai-dark",
    );
    const callbackUrl = `http://localhost:3000/coding-plan/payment/callback?channel=paypal&status=return&returnTo=${returnTo}&approval_token_id=setup-1`;
    listener?.(
      {
        sender,
        senderFrame: { url: "https://www.sandbox.paypal.com/agreements/approve" },
      },
      {
        sourceUrl: "file:///stale-host-url.html",
        url: callbackUrl,
      },
    );

    expect(sender.loadURL).toHaveBeenCalledWith(callbackUrl);
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("opens cross-origin Coding Plan callback openExternal requests externally", async () => {
    const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
    const options = createOptions();
    registerRemoteIpcHandlers(options);
    const listener = h.listeners.get(PlatformChannels.OpenExternal);
    expect(listener).toBeDefined();

    const sender = {
      getURL: vi.fn(() => "https://www.sandbox.paypal.com/agreements/approve"),
      loadURL: vi.fn(() => Promise.resolve()),
    };
    // returnTo 与回调页不同源即应外部打开；用中性域名表达“不同源”，不依赖测试环境域名
    //（开源导出会把测试域名改写成正式域名，回调与 returnTo 就变成同源）。
    const returnTo = encodeURIComponent(
      "https://other-origin.example/coding-plan?provider=zai&embedded=app",
    );
    const callbackUrl = `https://zcode.z.ai/coding-plan/payment/callback?channel=paypal&status=return&returnTo=${returnTo}`;
    listener?.({ sender }, callbackUrl);

    expect(sender.loadURL).not.toHaveBeenCalled();
    expect(h.shellOpenExternal).toHaveBeenCalledWith(callbackUrl);
  });
});

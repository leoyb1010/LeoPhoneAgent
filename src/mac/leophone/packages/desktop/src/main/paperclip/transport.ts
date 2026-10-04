import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import { PlatformChannels } from "@zcode/shared";
import {
  canonicalPaperclipOrigin,
  matchesPaperclipRenderer,
  publicPaperclipSession,
  safeDownloadFilename,
  validatePaperclipDownload,
  validatePaperclipRequest,
} from "./policy.js";

import { PaperclipSessionScope } from "./sessionScope.js";

type Login = { window: BrowserWindow; result: Promise<{ completed: boolean }>; cancel: () => void };
const logins = new Map<string, Login>();
const sessions = new Map<string, Session>();

const renderers = new Map<number, string>();
const scopes = new Map<string, PaperclipSessionScope>();
function scopeFor(origin: string): PaperclipSessionScope {
  let scope = scopes.get(origin);
  if (!scope) {
    scope = new PaperclipSessionScope();
    scopes.set(origin, scope);
  }
  return scope;
}

export function registerPaperclipWindow(window: BrowserWindow, rendererUrl: string): void {
  const id = window.webContents.id;
  renderers.set(id, rendererUrl);
  window.once("closed", () => renderers.delete(id));
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  const expected = renderers.get(event.sender.id);
  return Boolean(
    frame &&
    frame === event.sender.mainFrame &&
    expected &&
    matchesPaperclipRenderer(frame.url, expected),
  );
}

function requireSender(event: IpcMainInvokeEvent): BrowserWindow {
  if (!trustedSender(event)) throw new Error("此窗口不能访问 Paperclip 会话");
  return BrowserWindow.fromWebContents(event.sender)!;
}

function sessionFor(origin: string): Session {
  const existing = sessions.get(origin);
  if (existing) return existing;
  const partition = `persist:leophone-paperclip-${createHash("sha256").update(origin).digest("hex")}`;
  const isolated = session.fromPartition(partition);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  sessions.set(origin, isolated);
  return isolated;
}

async function limitedBody(
  response: Awaited<ReturnType<Session["fetch"]>>,
  maxBytes: number,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) throw new Error("服务器响应超过大小限制");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("服务器响应超过大小限制");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function request(
  origin: string,
  path: string,
  method: string,
  body?: unknown,
  allowSignOut = false,
) {
  return scopeFor(origin).run(async (signal) => {
    // 请求单次发送：网络断开或5xx不能证明写入失败，由业务receipt保留未知结果。
    const response = await sessionFor(origin).fetch(new URL(path, origin).href, {
      method,
      credentials: "include",
      redirect: "manual",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("服务器重定向已阻止，请检查服务器地址与反向代理");
    const bytes = await limitedBody(response, 8 * 1024 * 1024);
    const text = new TextDecoder().decode(bytes);
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("服务器未返回有效 JSON，请检查部署和反向代理");
      }
    }
    return {
      status: response.status,
      data:
        new URL(path, origin).pathname === "/api/auth/get-session"
          ? publicPaperclipSession(data)
          : data,
    };
  }, allowSignOut);
}

async function hasSession(origin: string): Promise<boolean> {
  try {
    const reply = await request(origin, "/api/auth/get-session", "GET");
    return reply.status === 200 && reply.data !== null;
  } catch {
    return false;
  }
}

async function signIn(origin: string, owner: BrowserWindow): Promise<{ completed: boolean }> {
  const scope = scopeFor(origin);
  const epoch = scope.generation;
  if (scope.signingOut) return { completed: false };
  const existing = logins.get(origin);
  if (existing) {
    existing.window.focus();
    return existing.result;
  }
  const ready = await hasSession(origin);
  if (epoch !== scope.generation || scope.signingOut || owner.isDestroyed())
    return { completed: false };
  if (ready) return { completed: true };
  // await期间可能已从另一个窗口开始登录；只保留一个登录窗口。
  const pending = logins.get(origin);
  if (pending) {
    pending.window.focus();
    return pending.result;
  }
  const loginWindow = new BrowserWindow({
    title: "登录 Paperclip 服务器",
    width: 720,
    height: 820,
    parent: owner,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      session: sessionFor(origin),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const permitNavigation = (event: Electron.Event, target: string) => {
    try {
      if (new URL(target).origin !== origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  loginWindow.webContents.on("will-navigate", permitNavigation);
  loginWindow.webContents.on("will-redirect", permitNavigation);
  loginWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  let finish: (completed: boolean) => void = () => undefined;
  const result = new Promise<{ completed: boolean }>((resolve) => {
    let settled = false;
    let checking = false;
    const check = async () => {
      if (settled || checking) return;
      checking = true;
      const ready = await hasSession(origin);
      checking = false;
      if (epoch !== scope.generation) finish(false);
      else if (ready) finish(true);
    };
    const poll = setInterval(() => {
      void check();
    }, 1500);
    const expiry = setTimeout(() => finish(false), 10 * 60_000);
    const ownerClosed = () => finish(false);
    finish = (completed) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(expiry);
      owner.off("closed", ownerClosed);
      logins.delete(origin);
      if (!loginWindow.isDestroyed()) loginWindow.close();
      resolve({ completed });
    };
    owner.once("closed", ownerClosed);
    loginWindow.once("closed", () => finish(false));
    loginWindow.webContents.on("did-finish-load", () => {
      void check();
    });
  });
  logins.set(origin, { window: loginWindow, result, cancel: () => finish(false) });
  loginWindow.once("ready-to-show", () => {
    if (!loginWindow.isDestroyed()) loginWindow.show();
  });
  // 上游 App.tsx 定义 path="auth"；无需向 renderer 暴露口令或 session token。
  void loginWindow.loadURL(`${origin}/auth`).catch(async () => {
    if (!loginWindow.isDestroyed()) {
      await dialog.showMessageBox(owner, {
        type: "error",
        title: "无法打开服务器登录",
        message: "请检查 HTTPS 证书、服务器地址和网络连接，然后重新登录。",
        buttons: ["知道了"],
      });
    }
    finish(false);
  });
  return result;
}

export function registerPaperclipIpc(): void {
  ipcMain.handle(PlatformChannels.PaperclipRequest, async (event, value: unknown) => {
    requireSender(event);
    const input = validatePaperclipRequest(value);
    return request(input.serverUrl, input.path, input.method, input.body);
  });
  ipcMain.handle(PlatformChannels.PaperclipSignIn, (event, value: { serverUrl: string }) => {
    const owner = requireSender(event);
    return signIn(canonicalPaperclipOrigin(value?.serverUrl), owner);
  });
  ipcMain.handle(PlatformChannels.PaperclipSignOut, async (event, value: { serverUrl: string }) => {
    requireSender(event);
    const origin = canonicalPaperclipOrigin(value?.serverUrl);
    const scope = scopeFor(origin);
    // 先推进代际并取消旧IO，登录窗口关闭后的迟到探测不会恢复已注销会话。
    const drain = scope.beginSignOut();
    logins.get(origin)?.cancel();
    await drain;
    try {
      const response = await request(origin, "/api/auth/sign-out", "POST", {}, true);
      if (response.status < 200 || response.status >= 300)
        throw new Error("服务器注销未确认，本机登录信息已清理");
    } finally {
      try {
        await sessionFor(origin).clearStorageData();
        await sessionFor(origin).clearCache();
      } finally {
        scope.finishSignOut();
      }
    }
  });
  ipcMain.handle(
    PlatformChannels.PaperclipDownload,
    async (event, value: { serverUrl: string; path: string; filename: string }) => {
      const owner = requireSender(event);
      const origin = canonicalPaperclipOrigin(value?.serverUrl);
      const url = validatePaperclipDownload(origin, value?.path);
      const selected = await dialog.showSaveDialog(owner, {
        title: "保存服务器产物",
        defaultPath: safeDownloadFilename(value?.filename),
      });
      if (selected.canceled || !selected.filePath) return;
      const data = await scopeFor(origin).run(async (signal) => {
        const response = await sessionFor(origin).fetch(url, {
          credentials: "include",
          redirect: "manual",
          signal,
        });
        if (!response.ok) throw new Error(`下载未完成（HTTP ${response.status}），请检查登录状态`);
        return limitedBody(response, 64 * 1024 * 1024);
      });
      await writeFile(selected.filePath, data);
    },
  );
}

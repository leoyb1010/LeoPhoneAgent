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

import { PAPERCLIP_DOWNLOAD_TIMEOUT_MS, PaperclipSessionScope } from "./sessionScope.js";

/**
 * Main 侧日志由调用方注入（index.ts 传入 main logger），本文件保持只依赖 Electron 与策略模块，
 * 独立传输类型检查和真实 Electron 回归夹具无需加载整个 main 日志链。
 * 日志只记录事件与状态码，绝不记录 Cookie、token、请求体、邮箱或服务器地址。
 */
interface PaperclipTransportLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
const silentLogger: PaperclipTransportLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
let log: PaperclipTransportLogger = silentLogger;

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
  // Cookie 变化可能意味着登录、注销或切换账号；身份确认缓存必须立即失效。
  isolated.cookies.on("changed", () => scopeFor(origin).invalidateIdentity());
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
  expectedUserId?: string,
) {
  const scope = scopeFor(origin);
  const epoch = scope.generation;
  const pathname = new URL(path, origin).pathname;
  return scope.run(async (signal) => {
    // 读请求可复用短缓存的身份确认；写请求必须新鲜确认（只可共享进行中的查询）。
    if (expectedUserId) await requireCurrentUser(origin, expectedUserId, epoch, method !== "GET");
    // 请求单次发送：网络断开或5xx不能证明写入失败，由业务receipt保留未知结果。
    const response = await fetchOnce(origin, new URL(path, origin).href, method, {
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
    if (response.status >= 300 && response.status < 400) {
      log.warn(`[paperclip] 已拦截服务器重定向 method=${method} status=${response.status}`);
      throw new Error("服务器重定向已阻止，请检查服务器地址与反向代理");
    }
    // 401 说明服务器会话已失效；get-session 自身的 401 是身份查询结果，不重复失效。
    if (response.status === 401 && pathname !== "/api/auth/get-session") {
      scope.invalidateIdentity();
      log.warn(`[paperclip] 服务器返回 401，已失效身份确认缓存 method=${method}`);
    }
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
      data: pathname === "/api/auth/get-session" ? publicPaperclipSession(data) : data,
    };
  }, allowSignOut);
}

/** 单次发送并记录传输异常；主动取消（注销、超时）属于预期中断，不按传输异常记录。 */
async function fetchOnce(
  origin: string,
  url: string,
  method: string,
  init: NonNullable<Parameters<Session["fetch"]>[1]>,
): Promise<Awaited<ReturnType<Session["fetch"]>>> {
  try {
    return await sessionFor(origin).fetch(url, init);
  } catch (error) {
    if (!init.signal?.aborted)
      log.error(
        `[paperclip] 服务器请求传输异常 method=${method} error=${error instanceof Error ? error.name : typeof error}`,
      );
    throw error;
  }
}

async function requireCurrentUser(
  origin: string,
  expectedUserId: string,
  epoch: number,
  fresh: boolean,
) {
  const scope = scopeFor(origin);
  // 对话框可能跨过整个注销/登录周期；先检查代际，旧操作不能在新会话里再发身份查询。
  if (scope.generation !== epoch || scope.signingOut)
    throw new Error("服务器会话已更改，请重新连接");
  // 身份绑定不能删除（账号隔离依赖它），只合并重复查询；见 PaperclipSessionScope.currentUser。
  const currentUserId = await scope.currentUser(async () => {
    const identity = await request(origin, "/api/auth/get-session", "GET");
    const current = identity.data as { user?: { id?: unknown } } | null;
    return identity.status === 200 && typeof current?.user?.id === "string"
      ? current.user.id
      : null;
  }, fresh);
  if (currentUserId !== expectedUserId || scope.generation !== epoch || scope.signingOut) {
    log.warn("[paperclip] 登录身份与操作绑定不一致，请求未发送");
    throw new Error("登录身份已改变，请重新选择公司；本次操作未发送");
  }
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
  // 登录窗口与工作台共享隔离会话；打开、完成、取消都可能改变登录者，确认缓存需失效。
  scope.invalidateIdentity();
  log.info("[paperclip] 登录窗口已创建");
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
      // 远端页面可用 beforeunload 阻止 close；先强制销毁，避免注销后旧登录页继续写 Cookie。
      if (!loginWindow.isDestroyed()) loginWindow.destroy();
      logins.delete(origin);
      scope.invalidateIdentity();
      log.info(`[paperclip] 登录窗口已销毁 completed=${completed}`);
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

export function registerPaperclipIpc(options: { logger?: PaperclipTransportLogger } = {}): void {
  log = options.logger ?? silentLogger;
  ipcMain.handle(PlatformChannels.PaperclipRequest, async (event, value: unknown) => {
    requireSender(event);
    const input = validatePaperclipRequest(value);
    return request(
      input.serverUrl,
      input.path,
      input.method,
      input.body,
      false,
      input.expectedUserId,
    );
  });
  ipcMain.handle(PlatformChannels.PaperclipSignIn, (event, value: { serverUrl: string }) => {
    const owner = requireSender(event);
    return signIn(canonicalPaperclipOrigin(value?.serverUrl), owner);
  });
  ipcMain.handle(PlatformChannels.PaperclipSignOut, async (event, value: { serverUrl: string }) => {
    requireSender(event);
    const origin = canonicalPaperclipOrigin(value?.serverUrl);
    const scope = scopeFor(origin);
    log.info("[paperclip] 开始注销服务器会话");
    // 先推进代际并取消旧IO，登录窗口关闭后的迟到探测不会恢复已注销会话。
    const drain = scope.beginSignOut();
    logins.get(origin)?.cancel();
    await drain;
    try {
      const response = await request(origin, "/api/auth/sign-out", "POST", {}, true);
      if (response.status < 200 || response.status >= 300) {
        log.warn(`[paperclip] 服务器注销未确认 status=${response.status}，仍清理本机会话`);
        throw new Error("服务器注销未确认，本机登录信息已清理");
      }
    } finally {
      try {
        await sessionFor(origin).clearStorageData();
        await sessionFor(origin).clearCache();
      } finally {
        scope.invalidateIdentity();
        scope.finishSignOut();
        log.info("[paperclip] 本机隔离会话已清理");
      }
    }
  });
  ipcMain.handle(
    PlatformChannels.PaperclipDownload,
    async (
      event,
      value: { serverUrl: string; path: string; filename: string; expectedUserId: string },
    ) => {
      const owner = requireSender(event);
      const origin = canonicalPaperclipOrigin(value?.serverUrl);
      const url = validatePaperclipDownload(origin, value?.path);
      if (
        typeof value?.expectedUserId !== "string" ||
        !value.expectedUserId.trim() ||
        value.expectedUserId.length > 256
      ) {
        throw new Error("下载必须绑定已登录的操作者，请重新连接服务器");
      }
      const scope = scopeFor(origin);
      const epoch = scope.generation;
      if (scope.signingOut) throw new Error("正在退出服务器，请稍候");
      const selected = await dialog.showSaveDialog(owner, {
        title: "保存服务器产物",
        defaultPath: safeDownloadFilename(value?.filename),
      });
      const selectedPath = selected.filePath;
      if (selected.canceled || !selectedPath) return;
      await scope.run(
        async (signal) => {
          // 下载属于敏感读取：必须新鲜确认身份，不复用读请求的短缓存。
          await requireCurrentUser(origin, value.expectedUserId, epoch, true);
          const response = await fetchOnce(origin, url, "GET", {
            credentials: "include",
            redirect: "manual",
            signal,
          });
          if (response.status === 401) {
            scope.invalidateIdentity();
            log.warn("[paperclip] 附件下载返回 401，已失效身份确认缓存");
          }
          if (!response.ok)
            throw new Error(`下载未完成（HTTP ${response.status}），请检查登录状态`);
          const data = await limitedBody(response, 64 * 1024 * 1024);
          // 注销会取消网络和文件 IO；不能把旧响应移出 scope 后才写入本机。
          if (scope.generation !== epoch || scope.signingOut)
            throw new Error("服务器会话已更改，下载已取消；文件未保存");
          signal.throwIfAborted();
          await writeFile(selectedPath, data, { signal });
        },
        false,
        // 64 MB 附件在慢速网络下读不完 60 秒，下载使用独立超时；普通 API 仍为 60 秒。
        PAPERCLIP_DOWNLOAD_TIMEOUT_MS,
      );
    },
  );
}

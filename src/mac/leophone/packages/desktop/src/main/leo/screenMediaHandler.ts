import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  session,
  type WebContents,
} from "electron";

/**
 * [leo][WP-51] 看屏 R1 的媒体端:一个不显示的窗口里跑采屏 + RTCPeerConnection(preload/leoScreenPeer.ts)。
 * 契约见 docs/specs/leo-screen.md「R1」。
 *
 * - Host 经截屏 unix socket 的 POST /peer 调这里(screenCapture.ts 转发);策略都在 Host,这里只执行。
 * - 窗口用独立的内存分区:setDisplayMediaRequestHandler 只作用于它,不影响主窗口 / 内嵌浏览器。
 * - 同时最多一路;没有会话就关窗口(采集随之停止,菜单栏的录屏指示也会消失)。
 */

const PARTITION = "leo-screen-peer";
const NEGOTIATION_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 15_000;

type Logger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

export interface PeerSessionState {
  id: string;
  state: string;
  control: boolean;
  createdAt: number;
}

let peerWindow: BrowserWindow | null = null;
let windowReady: Promise<BrowserWindow> | null = null;
let nextDisplayId: string | null = null;
let nextCommandId = 1;
const pending = new Map<number, (reply: { result?: unknown; error?: string }) => void>();
const sessions = new Map<string, PeerSessionState & { timer: NodeJS.Timeout | null }>();
const listeners = new Set<(sessions: PeerSessionState[]) => void>();
let inputSink: ((sessionId: string, data: string) => void) | null = null;
let ipcInstalled = false;

const publicSessions = (): PeerSessionState[] =>
  [...sessions.values()].map(({ id, state, control, createdAt }) => ({
    id,
    state,
    control,
    createdAt,
  }));

const notify = () => {
  const snapshot = publicSessions();
  for (const listener of listeners) listener(snapshot);
};

/** [WP-52] 菜单栏红点等需要知道「现在有没有人在看 / 在操控」。 */
export function onScreenPeerSessions(listener: (sessions: PeerSessionState[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** [WP-52] DataChannel 收到的输入事件交给谁(leo-input helper)。 */
export function setScreenPeerInputSink(sink: ((sessionId: string, data: string) => void) | null) {
  inputSink = sink;
}

function installIpc(logger: Logger): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  const fromPeer = (sender: WebContents) => peerWindow?.webContents === sender;
  ipcMain.on(
    "leo:screen-peer:reply",
    (event, reply: { id: number; result?: unknown; error?: string }) => {
      if (!fromPeer(event.sender)) return;
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    },
  );
  ipcMain.on(
    "leo:screen-peer:event",
    (
      event,
      payload: { sessionId: string; type: string; state?: string; open?: boolean; reason?: string },
    ) => {
      if (!fromPeer(event.sender)) return;
      const entry = sessions.get(payload.sessionId);
      if (!entry) return;
      if (payload.type === "state" && payload.state) {
        entry.state = payload.state;
        if (payload.state === "connected" && entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
      } else if (payload.type === "control") {
        entry.control = payload.open === true;
      } else if (payload.type === "closed") {
        logger.info(`[leo-screen] session ${payload.sessionId} closed: ${payload.reason ?? ""}`);
        forget(payload.sessionId);
        return;
      }
      notify();
    },
  );
  ipcMain.on("leo:screen-peer:input", (event, payload: { sessionId: string; data: string }) => {
    if (!fromPeer(event.sender)) return;
    // 只认当前已打开输入通道的会话;其余一律丢。
    if (sessions.get(payload.sessionId)?.control !== true) return;
    inputSink?.(payload.sessionId, payload.data);
  });
}

function forget(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  sessions.delete(sessionId);
  notify();
  if (sessions.size === 0) closeWindow();
}

function closeWindow(): void {
  const current = peerWindow;
  peerWindow = null;
  windowReady = null;
  for (const resolve of pending.values()) resolve({ error: "看屏窗口已关闭" });
  pending.clear();
  if (current && !current.isDestroyed()) current.destroy();
}

async function ensureWindow(logger: Logger): Promise<BrowserWindow> {
  if (windowReady) return windowReady;
  installIpc(logger);
  const peerSession = session.fromPartition(PARTITION);
  peerSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (
        !peerWindow ||
        request.frame !== peerWindow.webContents.mainFrame ||
        !request.videoRequested
      ) {
        callback({});
        return;
      }
      const wanted = nextDisplayId ?? String(screen.getPrimaryDisplay().id);
      void desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources.find((item) => item.display_id === wanted) ?? sources[0];
          callback(source ? { video: source } : {});
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  // 媒体之外什么权限都不给这个窗口。
  peerSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "media"),
  );
  windowReady = (async () => {
    const created = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/leoScreenPeer.cjs"),
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // 窗口不显示,不能让 Chromium 把它当后台页降频(编码会掉帧)。
        backgroundThrottling: false,
      },
    });
    peerWindow = created;
    created.on("closed", () => {
      if (peerWindow === created) {
        peerWindow = null;
        windowReady = null;
        for (const id of sessions.keys()) forget(id);
      }
    });
    created.webContents.on("render-process-gone", () => created.destroy());
    // 仿内置录屏器:临时空白页 + preload;file:// 是安全上下文,getDisplayMedia 可用。
    const page = join(tmpdir(), `leo-screen-peer-${process.pid}.html`);
    await writeFile(page, "<!doctype html><title>leo-screen-peer</title>", { mode: 0o600 });
    await created.loadFile(page);
    await rm(page, { force: true }).catch(() => undefined);
    return created;
  })();
  return windowReady;
}

async function command(logger: Logger, payload: Record<string, unknown>): Promise<unknown> {
  const target = await ensureWindow(logger);
  const id = nextCommandId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("看屏窗口没有响应"));
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.result);
    });
    target.webContents.send("leo:screen-peer:cmd", { id, command: payload });
  });
}

export interface PeerRequest {
  op: "open" | "ice" | "close" | "stats" | "status";
  sessionId?: string;
  offer?: string;
  displayId?: string;
  maxFps?: number;
  maxEdge?: number;
  iceServers?: unknown[];
  candidates?: unknown[];
  control?: boolean;
}

/** Host → 主进程(经截屏 socket 的 POST /peer)。 */
export async function handlePeerRequest(
  request: PeerRequest,
  logger: Logger,
): Promise<{ status: number; body: unknown }> {
  const fail = (status: number, code: string, message: string) => ({
    status,
    body: { code, message },
  });
  if (request.op === "status") return { status: 200, body: { sessions: publicSessions() } };
  const sessionId = request.sessionId ?? "";
  if (!/^scr_[0-9a-f-]{36}$/.test(sessionId)) return fail(400, "bad_session", "会话 id 不对");
  try {
    if (request.op === "open") {
      // 同时只一路:Host 已按设备裁决过,这里把旧的都关掉。
      for (const id of sessions.keys()) {
        await command(logger, { op: "close", sessionId: id }).catch(() => undefined);
        forget(id);
      }
      nextDisplayId = request.displayId ?? null;
      const entry = {
        id: sessionId,
        state: "new",
        control: false,
        createdAt: Date.now(),
        timer: setTimeout(() => {
          logger.info(`[leo-screen] session ${sessionId} not connected in time`);
          void command(logger, { op: "close", sessionId }).catch(() => undefined);
          forget(sessionId);
        }, NEGOTIATION_TIMEOUT_MS),
      };
      sessions.set(sessionId, entry);
      notify();
      try {
        const result = (await command(logger, {
          op: "open",
          sessionId,
          offer: request.offer ?? "",
          maxFps: request.maxFps ?? 30,
          maxEdge: request.maxEdge ?? 1920,
          iceServers: request.iceServers ?? [],
          control: request.control === true,
        })) as { answer: string };
        return { status: 200, body: { answer: result.answer } };
      } catch (error) {
        forget(sessionId);
        throw error;
      }
    }
    if (!sessions.has(sessionId)) return fail(404, "session_not_found", "看屏会话已结束");
    if (request.op === "close") {
      await command(logger, { op: "close", sessionId }).catch(() => undefined);
      forget(sessionId);
      return { status: 200, body: { ok: true } };
    }
    if (request.op === "ice") {
      await command(logger, { op: "ice", sessionId, candidates: request.candidates ?? [] });
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: await command(logger, { op: "stats", sessionId }) };
  } catch (error) {
    logger.warn(`[leo-screen] peer ${request.op} failed`, error);
    return fail(
      request.op === "open" ? 422 : 503,
      request.op === "open" ? "negotiation_failed" : "peer_unavailable",
      error instanceof Error ? error.message : "看屏连接失败",
    );
  }
}

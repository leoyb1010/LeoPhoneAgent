import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, Menu, nativeImage, shell, systemPreferences, Tray } from "electron";

import { hideControlHud, showControlHud } from "./screenControlHud.js";
import { parseInputEvent } from "./screenInputCore.js";
import {
  closeAllScreenPeers,
  onScreenPeerSessions,
  sendScreenPeerControlMessage,
  setScreenPeerInputSink,
} from "./screenMediaHandler.js";

/**
 * [leo][WP-52] 看屏 R2 输入接管的 Mac 端。契约见 docs/specs/leo-screen.md「R2」。
 *
 * - 某个视频会话的 leo-input DataChannel 打开(Host 只在 screen.control 允许时才让它打开)时拉起 leo-input
 *   助手;通道关了 / 会话结束就停掉助手、收起菜单栏红点。
 * - 手机发来的事件先过 parseInputEvent(只放行认识的形状),再一行一个 JSON 交给助手 CGEvent 注入。
 * - 被控制期间菜单栏多一个红点「正在被控制」(点开可立即断开);本机连按三次 Esc 也立即断开。
 */

type Logger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

const ACCESSIBILITY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "leo-input", "leo-input")
    : join(import.meta.dirname, "../../resources/leo-input/leo-input");
}

export function accessibilityGranted(): boolean {
  return process.platform === "darwin" && systemPreferences.isTrustedAccessibilityClient(false);
}

export async function openAccessibilitySettings(): Promise<void> {
  await shell.openExternal(ACCESSIBILITY_URL);
}

/** 16pt(@2x 32px)的红色实心圆:模板图标只能是单色,红点得自己画。 */
function redDot(): Electron.NativeImage {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      // 半径 8px(@2x),边缘 1px 抗锯齿。
      const alpha = Math.max(0, Math.min(1, 8.5 - distance));
      const offset = (y * size + x) * 4;
      pixels[offset] = 0x30; // B
      pixels[offset + 1] = 0x3b; // G
      pixels[offset + 2] = 0xff; // R
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
}

let started = false;

export function startScreenInput(logger: Logger): void {
  if (started || process.platform !== "darwin") return;
  started = true;
  let helper: ChildProcessWithoutNullStreams | null = null;
  let helperSession: string | null = null;
  let tray: Tray | null = null;

  const disconnect = (reason: string) => {
    logger.info(`[leo-input] disconnect: ${reason}`);
    void closeAllScreenPeers(logger);
  };

  const showTray = () => {
    if (tray && !tray.isDestroyed()) return;
    tray = new Tray(redDot());
    tray.setTitle(" 正在被控制");
    tray.setToolTip("手机正在操控这台 Mac · 连按三次 Esc 立即断开");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "手机正在操控这台 Mac", enabled: false },
        { label: "立即断开(或连按三次 Esc)", click: () => disconnect("tray") },
      ]),
    );
    // 红点可能被收进菜单栏溢出区:再加一个悬浮条,两者同时显示。
    showControlHud(() => disconnect("hud"));
    logger.info(
      `[leo-input] controlled indicator shown, tray at ${JSON.stringify(tray.getBounds())}`,
    );
  };

  const hideTray = () => {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
    hideControlHud();
  };

  const stopHelper = () => {
    // stdin EOF:助手松开还按着的鼠标键后自己退出。
    helper?.stdin.end();
    helper = null;
    helperSession = null;
  };

  const startHelper = (sessionId: string, displayId: string) => {
    if (helper && helperSession === sessionId) return;
    stopHelper();
    const binary = helperPath();
    if (!existsSync(binary)) {
      sendScreenPeerControlMessage(
        sessionId,
        JSON.stringify({ t: "status", ok: false, reason: "helper_missing" }),
      );
      return;
    }
    const args = ["serve", "--display", displayId];
    // 开发验证:事件只投给指定进程(测试窗口),不进系统事件流。打包版不认这个变量。
    const testPid = !app.isPackaged ? process.env["LEO_INPUT_TEST_PID"]?.trim() : undefined;
    if (testPid && /^\d+$/.test(testPid)) args.push("--target-pid", testPid);
    // 开发验证全局鼠标路径:每个事件发出前确认该位置最前面的窗口属于测试进程,否则助手立即退出。
    const frontPid = !app.isPackaged ? process.env["LEO_INPUT_TEST_FRONT_PID"]?.trim() : undefined;
    if (!testPid && frontPid && /^\d+$/.test(frontPid)) args.push("--require-front-pid", frontPid);
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    helper = child;
    helperSession = sessionId;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        let message: { type?: string; accessibility?: boolean; granted?: boolean } = {};
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.type === "local_escape") disconnect("escape x3");
        else if (message.type === "error") logger.warn(`[leo-input] ${line}`);
        else if (message.type === "ready" || message.type === "accessibility") {
          const granted = message.accessibility ?? message.granted ?? false;
          logger.info(`[leo-input] helper ${message.type}, accessibility=${granted}`);
          // 没有辅助功能授权时注入会被系统丢弃:告诉手机,让它提示用户去 Mac 上授权。
          sendScreenPeerControlMessage(
            sessionId,
            JSON.stringify({ t: "status", ok: granted, reason: granted ? null : "accessibility" }),
          );
        }
      }
    });
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => undefined);
    child.on("exit", () => {
      if (helper === child) {
        helper = null;
        helperSession = null;
      }
    });
  };

  setScreenPeerInputSink((sessionId, data) => {
    if (!helper || helperSession !== sessionId) return;
    const event = parseInputEvent(data);
    if (event) helper.stdin.write(`${JSON.stringify(event)}\n`);
  });

  onScreenPeerSessions((sessions) => {
    const controlled = sessions.find((session) => session.control);
    if (controlled) {
      startHelper(controlled.id, controlled.displayId);
      showTray();
    } else {
      stopHelper();
      hideTray();
    }
  });

  app.on("will-quit", () => {
    helper?.kill();
    hideTray();
  });
}

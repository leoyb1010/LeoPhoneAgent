import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { app, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";

import { isTrustedLeoSender } from "../leoLinkIpc.js";
import { validateQuickAccelerator } from "./quickPanelCore.js";
import {
  DEFAULT_SPEECH_SETTINGS,
  markdownToSpeech,
  parseSpeechLine,
  parseSpeechSettings,
  type SpeechEvent,
  type SpeechSettings,
} from "./speechCore.js";

/**
 * [leo][WP-60] 语音输入(按住快捷键说话)与朗读,只在 macOS。
 *
 * 渲染端负责按键(按下开始、松开结束)与把文字写进当前输入框;这里只管拉起本地助手程序 leo-speech、
 * 把它 stdout 的 JSON 事件转给发起的那个窗口。每个窗口同时最多一路听写、全局最多一路朗读。
 * 麦克风权限归 LeoBot(助手程序是它的子进程),Info.plist 里有 NSMicrophoneUsageDescription。
 */

const EVENT_CHANNEL = "leo:speech:event";
const SPEAK_STATE_CHANNEL = "leo:speech:speak-state";

type Logger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "leo-speech", "leo-speech")
    : join(import.meta.dirname, "../../resources/leo-speech/leo-speech");
}

/** 逐行读 stdout:一次 data 可能带半行或多行。 */
function onLines(child: ChildProcessWithoutNullStreams, handle: (line: string) => void): void {
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handle(line);
      index = buffer.indexOf("\n");
    }
  });
}

export function registerSpeechIpc(logger: Logger): void {
  if (process.platform !== "darwin") return;
  const settingsPath = join(app.getPath("userData"), "leo-speech.json");
  let settings: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS };
  const loaded = readFile(settingsPath, "utf8")
    .then((raw) => {
      settings = parseSpeechSettings(JSON.parse(raw));
    })
    .catch(() => undefined);

  const listening = new Map<number, ChildProcessWithoutNullStreams>();
  let speaking: { child: ChildProcessWithoutNullStreams; sender: WebContents } | null = null;

  const send = (sender: WebContents, channel: string, payload: unknown) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };

  const guard = (event: IpcMainInvokeEvent) => isTrustedLeoSender(event);

  ipcMain.handle("leo:speech:settings:get", async (event) => {
    if (!guard(event)) return { error: "forbidden" };
    await loaded;
    return { settings, available: existsSync(helperPath()) };
  });

  ipcMain.handle("leo:speech:settings:set", async (event, patch: unknown) => {
    if (!guard(event) || !patch || typeof patch !== "object") return { error: "forbidden" };
    await loaded;
    const value = patch as Record<string, unknown>;
    if (value["accelerator"] !== undefined) {
      const checked = validateQuickAccelerator(value["accelerator"]);
      if (!checked.ok)
        return { settings, available: existsSync(helperPath()), error: checked.reason };
    }
    settings = parseSpeechSettings({ ...settings, ...value });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8").catch(
      (error: unknown) => logger.warn("[leo-speech] failed to save settings", error),
    );
    return { settings, available: existsSync(helperPath()) };
  });

  ipcMain.handle("leo:speech:start", async (event) => {
    if (!guard(event)) return { ok: false, error: "forbidden" };
    await loaded;
    if (!settings.dictationEnabled) return { ok: false, error: "语音输入已关闭" };
    const binary = helperPath();
    if (!existsSync(binary)) return { ok: false, error: "这个版本没有带语音助手" };
    const sender = event.sender;
    listening.get(sender.id)?.kill();
    const args = ["listen", ...(settings.locale ? ["--locale", settings.locale] : [])];
    // 开发态端到端验证:用音频文件代替麦克风(不碰麦克风授权)。打包版不认这个变量。
    const testFile = !app.isPackaged ? process.env["LEO_SPEECH_TEST_FILE"]?.trim() : undefined;
    if (testFile) args.push("--file", testFile);
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    listening.set(sender.id, child);
    const startedAt = Date.now();
    let firstPartialLogged = false;
    onLines(child, (line) => {
      const parsed: SpeechEvent | null = parseSpeechLine(line);
      if (!parsed) return;
      if (parsed.type === "partial" && !firstPartialLogged) {
        firstPartialLogged = true;
        logger.info(`[leo-speech] first partial after ${Date.now() - startedAt}ms`);
      }
      send(sender, EVENT_CHANNEL, parsed);
    });
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => {
      send(sender, EVENT_CHANNEL, { type: "error", code: "failed", message: error.message });
    });
    child.on("exit", (code) => {
      if (listening.get(sender.id) === child) listening.delete(sender.id);
      // 助手自己会在出错时先发 error 再退出;这里补一个 done,渲染端据此收尾。
      send(sender, EVENT_CHANNEL, { type: "done", ...(code ? { exitCode: code } : {}) });
    });
    return { ok: true };
  });

  ipcMain.handle("leo:speech:stop", (event) => {
    if (!guard(event)) return false;
    const child = listening.get(event.sender.id);
    if (!child) return false;
    child.stdin.end("stop\n");
    return true;
  });

  ipcMain.handle("leo:speech:speak", async (event, markdown: unknown) => {
    if (!guard(event) || typeof markdown !== "string") return { ok: false, error: "forbidden" };
    await loaded;
    if (!settings.readAloudEnabled) return { ok: false, error: "朗读已关闭" };
    const binary = helperPath();
    if (!existsSync(binary)) return { ok: false, error: "这个版本没有带语音助手" };
    const text = markdownToSpeech(markdown);
    if (!text) return { ok: false, error: "没有可以朗读的文字" };
    // 同时只念一段:新的开始前把上一段停掉。
    if (speaking) {
      send(speaking.sender, SPEAK_STATE_CHANNEL, { speaking: false });
      speaking.child.kill();
    }
    const child = spawn(binary, ["speak"], { stdio: ["pipe", "pipe", "pipe"] });
    const current = { child, sender: event.sender };
    speaking = current;
    child.stdout.resume();
    child.stderr.resume();
    child.on("exit", () => {
      if (speaking === current) {
        speaking = null;
        send(current.sender, SPEAK_STATE_CHANNEL, { speaking: false });
      }
    });
    child.stdin.end(text);
    send(event.sender, SPEAK_STATE_CHANNEL, { speaking: true });
    return { ok: true };
  });

  ipcMain.handle("leo:speech:stop-speaking", (event) => {
    if (!guard(event) || !speaking) return false;
    speaking.child.kill();
    return true;
  });

  ipcMain.handle("leo:speech:open-mic-settings", async (event) => {
    if (!guard(event)) return false;
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
    return true;
  });

  app.on("will-quit", () => {
    for (const child of listening.values()) child.kill();
    speaking?.child.kill();
  });
}

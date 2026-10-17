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
  SPEECH_IDLE_RELEASE_MS,
  type SpeechEvent,
  type SpeechSettings,
} from "./speechCore.js";

/**
 * [leo][WP-60] 语音输入(按住快捷键说话)与朗读,只在 macOS。
 *
 * 渲染端负责按键(按下开始、松开结束)与把文字写进当前输入框;这里只管本地助手程序 leo-speech:
 * 听写用常驻的 serve(预热,见下),把它 stdout 的 JSON 事件转给发起的那个窗口;全局同时一路听写、一路朗读。
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

  let speaking: { child: ChildProcessWithoutNullStreams; sender: WebContents } | null = null;

  const send = (sender: WebContents, channel: string, payload: unknown) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };

  const guard = (event: IpcMainInvokeEvent) => isTrustedLeoSender(event);

  // [WP-60 预热] 听写助手常驻(leo-speech serve):进输入框时就拉起并把模型备好,按键只发一条 start。
  // 以前每次按键才 spawn + 装资源 + 加载模型,~1.2s 内说的话会丢。全局一个助手,同时一路听写;
  // 助手按顺序处理指令,每段以 done 结尾,所以用一个队列记「这段是谁发起的」,事件发给队首。
  let helper: ChildProcessWithoutNullStreams | null = null;
  let helperLocale: string | null = null;
  const owners: { sender: WebContents; startedAt: number; firstPartialLogged: boolean }[] = [];
  let idleTimer: NodeJS.Timeout | null = null;

  const releaseHelper = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    // stdin EOF:助手收尾当前段后自己退出。
    helper?.stdin.end();
    helper = null;
  };

  const touchIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (owners.length === 0) releaseHelper();
      else touchIdle();
    }, SPEECH_IDLE_RELEASE_MS);
    idleTimer.unref();
  };

  const ensureHelper = (): ChildProcessWithoutNullStreams | null => {
    touchIdle();
    if (helper && helperLocale === settings.locale) return helper;
    if (helper) releaseHelper();
    const binary = helperPath();
    if (!existsSync(binary)) return null;
    const spawnedAt = Date.now();
    const child = spawn(
      binary,
      ["serve", ...(settings.locale ? ["--locale", settings.locale] : [])],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    helper = child;
    helperLocale = settings.locale;
    onLines(child, (line) => {
      const parsed: SpeechEvent | null = parseSpeechLine(line);
      if (!parsed) return;
      if (parsed.type === "warm") {
        logger.info(`[leo-speech] helper warm after ${Date.now() - spawnedAt}ms`);
        return;
      }
      const owner = owners[0];
      if (!owner) return;
      if (parsed.type === "partial" && !owner.firstPartialLogged) {
        owner.firstPartialLogged = true;
        logger.info(`[leo-speech] first partial after ${Date.now() - owner.startedAt}ms`);
      }
      send(owner.sender, EVENT_CHANNEL, parsed);
      if (parsed.type === "done") owners.shift();
    });
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => logger.warn("[leo-speech] helper failed", error));
    child.on("exit", (code) => {
      if (helper === child) helper = null;
      // 助手中途没了:还在等的每一段都补一个 done,渲染端据此收尾。
      for (const owner of owners.splice(0)) {
        send(owner.sender, EVENT_CHANNEL, { type: "done", ...(code ? { exitCode: code } : {}) });
      }
    });
    return child;
  };

  const command = (payload: Record<string, unknown>) => {
    helper?.stdin.write(`${JSON.stringify(payload)}\n`);
  };

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
    // 换了语言或关掉听写:常驻助手按旧设置备的模型作废。
    if (!settings.dictationEnabled || settings.locale !== helperLocale) releaseHelper();
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8").catch(
      (error: unknown) => logger.warn("[leo-speech] failed to save settings", error),
    );
    return { settings, available: existsSync(helperPath()) };
  });

  ipcMain.handle("leo:speech:prewarm", async (event) => {
    if (!guard(event)) return false;
    await loaded;
    if (!settings.dictationEnabled) return false;
    return ensureHelper() !== null;
  });

  ipcMain.handle("leo:speech:start", async (event) => {
    if (!guard(event)) return { ok: false, error: "forbidden" };
    await loaded;
    if (!settings.dictationEnabled) return { ok: false, error: "语音输入已关闭" };
    if (!ensureHelper()) return { ok: false, error: "这个版本没有带语音助手" };
    // 同时只一路:上一段还没结束就丢弃它(它的 done 仍会按顺序发回原窗口)。
    if (owners.length > 0) command({ cmd: "cancel" });
    owners.push({ sender: event.sender, startedAt: Date.now(), firstPartialLogged: false });
    // 开发态端到端验证:用音频文件代替麦克风(不碰麦克风授权)。打包版不认这个变量。
    const testFile = !app.isPackaged ? process.env["LEO_SPEECH_TEST_FILE"]?.trim() : undefined;
    command({ cmd: "start", ...(testFile ? { file: testFile } : {}) });
    return { ok: true };
  });

  ipcMain.handle("leo:speech:stop", (event) => {
    if (!guard(event)) return false;
    if (owners.at(-1)?.sender !== event.sender) return false;
    command({ cmd: "stop" });
    touchIdle();
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
    helper?.kill();
    speaking?.child.kill();
  });
}

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";

import { callLeoQuick, isTrustedLeoSender } from "../leoLinkIpc.js";
import {
  buildQuickTrayMenu,
  computeQuickPanelBounds,
  DEFAULT_QUICK_ENTRY_SETTINGS,
  formatAcceleratorLabel,
  nextSummaryPollDelay,
  parseQuickEntrySettings,
  QUICK_PANEL_SIZE,
  trayTitle,
  validateQuickAccelerator,
  type QuickEntrySettings,
  type QuickSummaryView,
} from "./quickPanelCore.js";

/**
 * [leo] macOS 菜单栏图标 + ⌥Space 快速派发浮窗(规则见 docs/specs/leo-quick-entry.md)。
 *
 * 主进程不存任务状态:菜单与浮窗的数据都来自 Host 的 /api/leo/quick/summary,派发走
 * /api/leo/quick/dispatch,由 Host 建任务并发首条输入。这里只管窗口、全局快捷键和轮询节奏。
 */

const PANEL_STATE_CHANNEL = "leo:quick:panel:state";
const PANEL_DISPATCH_CHANNEL = "leo:quick:panel:dispatch";
const PANEL_HIDE_CHANNEL = "leo:quick:panel:hide";
const SETTINGS_GET_CHANNEL = "leo:quick:settings:get";
const SETTINGS_SET_CHANNEL = "leo:quick:settings:set";
/** 主进程 → 主窗口:定位到某个任务(渲染端用侧栏同一个 handleSelectTask,能跨工作区切 tab)。 */
const OPEN_TASK_CHANNEL = "leo:quick:open-task";
/** 浮窗预热:启动后稍等再建,不和首屏抢资源;建好后 ⌥Space 只需 setBounds + show。 */
const PANEL_PREWARM_DELAY_MS = 4_000;
/** 菜单点开前最多等这么久拿新数据,超时就用上一份。 */
const MENU_REFRESH_BUDGET_MS = 400;

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

interface LeoQuickEntryDeps {
  logger: Logger;
  trayIconPath: string;
  preloadPath: string;
  rendererDir: string;
  rendererDevUrl?: string | undefined;
  /** 打开(必要时新建)主窗口,返回它;Host 跟着窗口起来。 */
  showMainWindow: () => Promise<BrowserWindow | null>;
  quitApp: () => void;
}

interface QuickSettingsResult {
  settings: QuickEntrySettings;
  acceleratorLabel: string;
  /** 当前快捷键没能注册上(被系统或别的 App 占用)时的说明。 */
  shortcutError: string | null;
}

type OpenTaskTarget = { taskId: string; workspacePath: string; workspaceIdentity?: string };

type DispatchResult = { ok: true; taskId: string } | { ok: false; error: string };

let quickPanelWindow: BrowserWindow | null = null;

/**
 * 浮窗是个 BrowserWindow,会出现在 BrowserWindow.getAllWindows() 里。主进程「找主窗口」的地方
 * (primaryWindowCoordinator、Dock 点击、派发并打开)必须把它排除,否则会把浮窗当主窗口重新 show 出来。
 */
export function isLeoQuickPanelWindow(window: BrowserWindow): boolean {
  return quickPanelWindow !== null && window === quickPanelWindow;
}

export function startLeoQuickEntry(deps: LeoQuickEntryDeps): void {
  if (process.platform !== "darwin") return;
  const { logger } = deps;
  const settingsPath = join(app.getPath("userData"), "leo-quick-entry.json");
  let settings: QuickEntrySettings = { ...DEFAULT_QUICK_ENTRY_SETTINGS };
  let registeredAccelerator: string | null = null;
  let shortcutError: string | null = null;

  let summary: QuickSummaryView | null = null;
  let summaryError: string | undefined;
  let pollTimer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> | null = null;

  let tray: Tray | null = null;
  let panel: BrowserWindow | null = null;
  let panelLoaded: Promise<void> | null = null;
  let shownAt = 0;
  /** 自己记显示状态:hide() 之后紧跟的 blur 里 isVisible() 有时还是 true,会重复收起一次。 */
  let panelVisible = false;
  /** 呼出前前台是不是别的 App:收起时把焦点还回去,不让主窗口顶到前面。 */
  let returnFocusOnHide = false;
  let lastWorkspace: string | null = null;

  // ── Host 摘要与轮询 ────────────────────────────────────────────────────

  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      const result = await callLeoQuick("/api/leo/quick/summary");
      if (result.ok) {
        summary = result.data as unknown as QuickSummaryView;
        summaryError = undefined;
      } else {
        summary = null;
        summaryError = result.error;
      }
      renderTray();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const schedulePoll = (delay = nextSummaryPollDelay(summary)) => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!settings.menuBarEnabled && !settings.quickPanelEnabled) return;
    pollTimer = setTimeout(() => {
      void refresh().finally(() => schedulePoll());
    }, delay);
    pollTimer.unref();
  };

  // ── 菜单栏 ─────────────────────────────────────────────────────────────

  const openTask = async (target: OpenTaskTarget, settleMs: number[] = [0]) => {
    const window = await deps.showMainWindow();
    if (!window) return;
    // 刚派发的任务渲染端可能还没收到它的列表行,隔一会儿再定位一次;同一个任务重复定位是幂等的。
    for (const delay of settleMs) {
      setTimeout(() => {
        if (!window.isDestroyed()) window.webContents.send(OPEN_TASK_CHANNEL, target);
      }, delay).unref();
    }
  };

  const buildMenu = (): Menu => {
    const model = buildQuickTrayMenu(summary, {
      quickPanelEnabled: settings.quickPanelEnabled,
      ...(registeredAccelerator ? { accelerator: registeredAccelerator } : {}),
      ...(summaryError ? { hostError: summaryError } : {}),
    });
    const template = model.map((item): MenuItemConstructorOptions => {
      switch (item.kind) {
        case "header":
          return { label: item.label, enabled: false };
        case "info":
          return { label: item.label, enabled: false };
        case "separator":
          return { type: "separator" };
        case "task":
          return {
            label: item.label,
            click: () =>
              void openTask({
                taskId: item.taskId,
                workspacePath: item.workspacePath,
                ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
              }),
          };
        case "new-task":
          return {
            label: item.label,
            // 只用来在菜单里显示键位;真正的全局快捷键由 globalShortcut 注册。
            ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
            click: () => void showPanel(),
          };
        case "open-app":
          return { label: item.label, click: () => void deps.showMainWindow() };
        case "quit":
          return { label: item.label, click: deps.quitApp };
      }
    });
    return Menu.buildFromTemplate(template);
  };

  const renderTray = () => {
    if (!tray || tray.isDestroyed()) return;
    tray.setTitle(trayTitle(summary), { fontType: "monospacedDigit" });
    const waiting = summary?.waiting.length ?? 0;
    const running = summary?.running.length ?? 0;
    tray.setToolTip(
      waiting > 0 ? `LeoBot · ${waiting} 个等你确认` : running > 0 ? `LeoBot · ${running} 个在跑` : "LeoBot",
    );
  };

  const popUpMenu = async () => {
    // 先拿一份新数据再弹菜单(最多等一小会儿),不然刚跑完的任务还显示在跑。
    await Promise.race([refresh(), new Promise((resolve) => setTimeout(resolve, MENU_REFRESH_BUDGET_MS))]);
    tray?.popUpContextMenu(buildMenu());
  };

  const syncTray = () => {
    if (settings.menuBarEnabled && !tray) {
      try {
        const image = nativeImage.createFromPath(deps.trayIconPath);
        image.setTemplateImage(true);
        tray = new Tray(image);
        // 不用 setContextMenu:那样点开时拿不到刷新的机会。
        tray.on("click", () => void popUpMenu());
        tray.on("right-click", () => void popUpMenu());
        renderTray();
      } catch (error) {
        logger.warn("[leo-quick] tray creation failed", error);
        tray = null;
      }
    } else if (!settings.menuBarEnabled && tray) {
      tray.destroy();
      tray = null;
    }
  };

  // ── 浮窗 ───────────────────────────────────────────────────────────────

  const ensurePanel = (): BrowserWindow => {
    if (panel && !panel.isDestroyed()) return panel;
    const window = new BrowserWindow({
      ...QUICK_PANEL_SIZE,
      // NSPanel:像 Spotlight 一样浮在别的 App 上;能拿焦点(要打字),失焦就收起。
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // 浮窗大部分时间藏着;不节流,呼出时不用等渲染进程从后台节流里醒过来。
        backgroundThrottling: false,
      },
    });
    // floating 层级:压过普通窗口,但在输入法候选窗之下(screen-saver 会把中文候选词盖住)。
    window.setAlwaysOnTop(true, "floating");
    // 全屏 App 的 Space 里也能呼出。只在建窗时调一次:每次调用都会让 Dock 图标闪一下。
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on("blur", () => hidePanel("blur"));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panelLoaded =
      !app.isPackaged && deps.rendererDevUrl
        ? window.loadURL(`${deps.rendererDevUrl}/leo-quick-panel.html`)
        : window.loadFile(join(deps.rendererDir, "leo-quick-panel.html"));
    panelLoaded.catch((error: unknown) => logger.warn("[leo-quick] panel failed to load", error));
    window.on("closed", () => {
      if (panel === window) {
        panel = null;
        panelVisible = false;
      }
      if (quickPanelWindow === window) quickPanelWindow = null;
    });
    panel = window;
    quickPanelWindow = window;
    return window;
  };

  const pushPanelState = (window: BrowserWindow) => {
    const workspaces = summary?.workspaces ?? [];
    window.webContents.send(PANEL_STATE_CHANNEL, {
      workspaces,
      selected: lastWorkspace && workspaces.includes(lastWorkspace) ? lastWorkspace : (workspaces[0] ?? null),
      error: workspaces.length === 0 ? (summaryError ?? null) : null,
    });
  };

  const showPanel = async () => {
    if (!settings.quickPanelEnabled) return;
    const startedAt = performance.now();
    const window = ensurePanel();
    if (panelVisible) {
      hidePanel("toggle");
      return;
    }
    returnFocusOnHide = BrowserWindow.getFocusedWindow() === null;
    window.setBounds(computeQuickPanelBounds(screen.getCursorScreenPoint(), screen.getAllDisplays()));
    await panelLoaded?.catch(() => undefined);
    pushPanelState(window);
    panelVisible = true;
    window.show();
    // 别的 App 在前台时,只 focus() 的激活请求会被系统的协作式激活拒掉,浮窗几十毫秒后就失焦收起;
    // 由全局快捷键触发属于用户主动操作,这里显式抢一次前台。
    app.focus({ steal: true });
    window.focus();
    shownAt = performance.now();
    logger.info(`[leo-quick] panel shown in ${Math.round(shownAt - startedAt)}ms`);
    // 工作区列表在后台刷新,回来再推一次;不挡着浮窗出现。
    void refresh().then(() => {
      if (panelVisible) pushPanelState(window);
    });
  };

  const hidePanel = (reason: "blur" | "escape" | "dispatched" | "toggle" | "open") => {
    const window = panel;
    if (!window || window.isDestroyed() || !panelVisible) return;
    panelVisible = false;
    window.hide();
    logger.info(`[leo-quick] panel hidden (${reason}) after ${Math.round(performance.now() - shownAt)}ms`);
    // 呼出前在用别的 App:收起后把焦点还给它,否则 macOS 会把我们的主窗口顶到前面。
    // 失焦收起时焦点已经在别处;「派发并打开」要的就是主窗口。
    if (returnFocusOnHide && reason !== "blur" && reason !== "open") app.hide();
  };

  // ── 全局快捷键 ─────────────────────────────────────────────────────────

  const registerShortcut = (accelerator: string): string | null => {
    if (registeredAccelerator) globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = null;
    if (!settings.quickPanelEnabled) return null;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => void showPanel());
    } catch (error) {
      logger.warn("[leo-quick] shortcut registration threw", error);
    }
    if (!ok) return `${formatAcceleratorLabel(accelerator)} 被系统或别的 App 占用了，换一个试试`;
    registeredAccelerator = accelerator;
    return null;
  };

  // ── 设置 ───────────────────────────────────────────────────────────────

  const settingsResult = (): QuickSettingsResult => ({
    settings,
    acceleratorLabel: formatAcceleratorLabel(settings.accelerator),
    shortcutError,
  });

  const persist = async () => {
    try {
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    } catch (error) {
      logger.warn("[leo-quick] failed to save settings", error);
    }
  };

  const applySettings = async (patch: Record<string, unknown>): Promise<QuickSettingsResult & { error?: string }> => {
    const next: QuickEntrySettings = { ...settings };
    if (typeof patch["menuBarEnabled"] === "boolean") next.menuBarEnabled = patch["menuBarEnabled"];
    if (typeof patch["quickPanelEnabled"] === "boolean") next.quickPanelEnabled = patch["quickPanelEnabled"];
    if (patch["accelerator"] !== undefined) {
      const checked = validateQuickAccelerator(patch["accelerator"]);
      if (!checked.ok) return { ...settingsResult(), error: checked.reason };
      next.accelerator = checked.accelerator;
    }
    const previous = settings;
    settings = next;
    if (next.quickPanelEnabled) {
      const error = registerShortcut(next.accelerator);
      if (error && next.accelerator !== previous.accelerator) {
        // 新键位注册不上:退回上一个能用的,不能让用户一改就没了快捷键。
        settings = { ...next, accelerator: previous.accelerator };
        shortcutError = registerShortcut(previous.accelerator);
        return { ...settingsResult(), error };
      }
      shortcutError = error;
    } else {
      registerShortcut(next.accelerator);
      shortcutError = null;
      if (panel && !panel.isDestroyed()) panel.destroy();
      panel = null;
    }
    // 重新打开快速派发:先把浮窗建好,下次按快捷键不用等建窗。
    if (next.quickPanelEnabled && !previous.quickPanelEnabled) ensurePanel();
    syncTray();
    schedulePoll(0);
    await persist();
    return settingsResult();
  };

  // ── IPC ────────────────────────────────────────────────────────────────

  const fromPanel = (event: IpcMainInvokeEvent | Electron.IpcMainEvent) =>
    Boolean(panel && !panel.isDestroyed() && event.sender === panel.webContents);

  ipcMain.handle(PANEL_DISPATCH_CHANNEL, async (event, payload: unknown): Promise<DispatchResult> => {
    if (!fromPanel(event)) return { ok: false, error: "forbidden" };
    const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const request = { prompt: body["prompt"], workspacePath: body["workspacePath"] };
    let result = await callLeoQuick("/api/leo/quick/dispatch", request);
    if (!result.ok && /没启动/.test(result.error)) {
      // 主窗口都关了时 Host 不在:先把主窗口拉起来(Host 跟着起),再派一次。
      await deps.showMainWindow();
      for (let attempt = 0; attempt < 30 && !result.ok; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        result = await callLeoQuick("/api/leo/quick/dispatch", request);
      }
    }
    if (!result.ok) return { ok: false, error: result.error };
    const taskId = String(result.data["taskId"] ?? "");
    const workspacePath = String(result.data["workspacePath"] ?? "");
    if (workspacePath) lastWorkspace = workspacePath;
    logger.info("[leo-quick] dispatched", { taskId });
    schedulePoll(300);
    if (body["open"] === true) {
      hidePanel("open");
      void openTask({ taskId, workspacePath }, [300, 1_500]);
    }
    return { ok: true, taskId };
  });
  ipcMain.on(PANEL_HIDE_CHANNEL, (event, reason: unknown) => {
    if (!fromPanel(event)) return;
    hidePanel(reason === "dispatched" ? "dispatched" : "escape");
  });
  ipcMain.handle(SETTINGS_GET_CHANNEL, (event) =>
    isTrustedLeoSender(event) ? settingsResult() : { error: "forbidden" },
  );
  ipcMain.handle(SETTINGS_SET_CHANNEL, (event, patch: unknown) =>
    isTrustedLeoSender(event) && patch && typeof patch === "object"
      ? applySettings(patch as Record<string, unknown>)
      : { error: "forbidden" },
  );

  app.on("will-quit", () => {
    if (registeredAccelerator) globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = null;
    if (pollTimer) clearTimeout(pollTimer);
  });

  // ── 启动 ───────────────────────────────────────────────────────────────

  void (async () => {
    try {
      settings = parseQuickEntrySettings(JSON.parse(await readFile(settingsPath, "utf8")));
    } catch {
      settings = { ...DEFAULT_QUICK_ENTRY_SETTINGS };
    }
    shortcutError = registerShortcut(settings.accelerator);
    if (shortcutError) logger.warn(`[leo-quick] ${shortcutError}`);
    syncTray();
    schedulePoll(1_500);
    if (settings.quickPanelEnabled) {
      setTimeout(() => {
        if (settings.quickPanelEnabled) ensurePanel();
      }, PANEL_PREWARM_DELAY_MS).unref();
    }
  })();
}

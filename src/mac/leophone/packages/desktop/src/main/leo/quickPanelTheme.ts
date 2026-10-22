import { parseQuickPanelAppTheme, type QuickPanelAppTheme } from "./quickPanelCore.js";

/**
 * [leo][G3] ⌥Space 浮窗跟 App 的外观设置(浅色 / 深色 / 跟随系统)走,不只看系统外观。
 *
 * 主窗口同步原生主题时(desktopMainIpcPlatform 的 SetTitleBarTheme)调 setLeoQuickPanelAppTheme;
 * 快速派发读完设置文件后用 onLeoQuickPanelAppTheme 接上。以前浮窗只认 prefers-color-scheme,
 * App 设成浅色、系统是深色时,刚启动主窗口还没同步前呼出的浮窗是深色的。
 */
let pending: QuickPanelAppTheme | null = null;
let listener: ((theme: QuickPanelAppTheme) => void) | null = null;

export function setLeoQuickPanelAppTheme(theme: unknown): void {
  const parsed = parseQuickPanelAppTheme(theme);
  if (!parsed) return;
  if (listener) listener(parsed);
  else pending = parsed;
}

/** 接上后先补发接上前收到的那一次。 */
export function onLeoQuickPanelAppTheme(callback: (theme: QuickPanelAppTheme) => void): void {
  listener = callback;
  if (pending) callback(pending);
  pending = null;
}

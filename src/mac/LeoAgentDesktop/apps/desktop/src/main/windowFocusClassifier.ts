import type { BrowserWindow } from 'electron';

const appContentWindows = new WeakSet<BrowserWindow>();

export function markAppContentWindow(win: BrowserWindow): void {
  appContentWindows.add(win);
}

export function isAppContentWindow(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return Boolean(win && !win.isDestroyed() && appContentWindows.has(win));
}

export function isFocusedAppContentWindow(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return isAppContentWindow(win) && win.isFocused();
}

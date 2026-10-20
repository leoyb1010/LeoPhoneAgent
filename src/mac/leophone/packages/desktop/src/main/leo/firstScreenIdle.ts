import { app, BrowserWindow } from "electron";

/** 主窗口(非浮窗)首屏加载完后再空闲 idleMs 调 run;只调一次。 */
export function afterFirstScreenIdle(
  run: () => void,
  idleMs: number,
  fallbackMs: number,
  skip: (window: BrowserWindow) => boolean = () => false,
): void {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    app.off("browser-window-created", onCreated);
    clearTimeout(fallback);
    setTimeout(run, idleMs).unref();
  };
  const watch = (window: BrowserWindow) => {
    if (fired || window.isDestroyed() || skip(window)) return;
    const contents = window.webContents;
    if (contents.getURL() && !contents.isLoading()) fire();
    else contents.once("did-finish-load", fire);
  };
  const onCreated = (_event: unknown, window: BrowserWindow) => watch(window);
  const fallback = setTimeout(fire, fallbackMs);
  fallback.unref();
  app.on("browser-window-created", onCreated);
  for (const window of BrowserWindow.getAllWindows()) watch(window);
}

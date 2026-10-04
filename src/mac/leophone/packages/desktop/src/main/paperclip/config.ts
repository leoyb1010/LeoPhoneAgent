import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { PlatformChannels, paperclipPreferencesSchema, type AppSettings } from "@zcode/shared";
import { canonicalPaperclipOrigin, matchesPaperclipRenderer } from "./policy.js";

const renderers = new Map<number, string>();
export function registerPaperclipConfigWindow(window: BrowserWindow, rendererUrl: string): void {
  const id = window.webContents.id;
  renderers.set(id, rendererUrl);
  window.once("closed", () => renderers.delete(id));
}
function requireRenderer(event: IpcMainInvokeEvent): void {
  const expected = renderers.get(event.sender.id);
  if (
    !expected ||
    event.senderFrame !== event.sender.mainFrame ||
    !event.senderFrame ||
    !matchesPaperclipRenderer(event.senderFrame.url, expected)
  ) {
    throw new Error("此窗口不能访问服务器配置。");
  }
}
export function registerPaperclipConfigIpc(settings: {
  get(): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<void>;
}): void {
  ipcMain.handle(PlatformChannels.PaperclipPreferencesGet, async (event) => {
    requireRenderer(event);
    return paperclipPreferencesSchema.parse((await settings.get()).paperclipPreferences ?? {});
  });
  ipcMain.handle(PlatformChannels.PaperclipPreferencesSet, async (event, value: unknown) => {
    requireRenderer(event);
    if (JSON.stringify(value).length > 65536) throw new Error("服务器配置超过大小限制。");
    const preferences = paperclipPreferencesSchema.parse(value);
    if (preferences.origin) preferences.origin = canonicalPaperclipOrigin(preferences.origin);
    await settings.update({ paperclipPreferences: preferences });
  });
}

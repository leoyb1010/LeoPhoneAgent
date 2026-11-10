import { app, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

/**
 * [leo] 特权 IPC 的调用方校验：只认应用窗口自己的顶层页面（契约见 docs/specs/desktop-renderer-boundary.md §2）。
 *
 * 原先只在 leoLinkIpc 里用（isTrustedLeoSender），打开本地文件这类通道没有校验：内嵌浏览器（webview 访客）
 * 或页面里的 iframe 都能调。这里把同一套规则提出来，供需要的通道复用，规则本身不变：
 * - 必须是 sender 的主 frame（iframe 调不到）；
 * - sender 必须是应用窗口（webview 访客里打开的本地 HTML 也是 file://，要排除）；
 * - 生产只认 file:// 页面，开发态另认本机 Vite。
 */
export function isTrustedAppSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  if (event.sender.getType() !== "window") return false;
  const url = frame.url ?? "";
  if (url.startsWith("file://")) return true;
  return !app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url);
}

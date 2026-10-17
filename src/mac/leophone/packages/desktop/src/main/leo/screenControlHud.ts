import { BrowserWindow, screen } from "electron";

/**
 * [leo][WP-52] 被手机操控时屏幕顶部的悬浮提示「正在被控制 · 断开」。
 *
 * 菜单栏红点可能被系统 / 菜单栏管理工具收进溢出区(实测会),所以再加一个总在最前、所有桌面(含全屏 App)
 * 都可见、不抢焦点的小条。用不激活的 panel 窗口,点「断开」不会把 LeoBot 拉到前台,也不打断正在被操控的 App。
 * 页面是一段内联 HTML,没有 preload:按钮是一个链接,这里拦下它的导航当作点击。
 */

const WIDTH = 260;
const HEIGHT = 40;
// 不会真的去请求:will-navigate 里就拦下了(.invalid 也保证解析不到任何主机)。
const DISCONNECT_URL = "https://leo-hud.invalid/disconnect";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;cursor:default}
.bar{box-sizing:border-box;height:${HEIGHT}px;display:flex;align-items:center;gap:10px;padding:0 6px 0 14px;
border-radius:${HEIGHT / 2}px;background:rgba(28,28,30,.92);color:#fff;font:500 13px -apple-system,sans-serif;
border:1px solid rgba(255,255,255,.12)}
.dot{width:10px;height:10px;border-radius:50%;background:#ff3b30;box-shadow:0 0 0 3px rgba(255,59,48,.25);
animation:p 1.6s ease-in-out infinite}
@keyframes p{50%{opacity:.45}}@media (prefers-reduced-motion:reduce){.dot{animation:none}}
.t{flex:1;white-space:nowrap}
a{color:#fff;text-decoration:none;background:#ff3b30;border-radius:14px;padding:5px 12px;font-weight:600}
a:active{opacity:.8}
</style></head><body><div class="bar"><span class="dot"></span><span class="t">正在被手机控制</span>
<a href="${DISCONNECT_URL}" title="或在 Mac 上连按三次 Esc">断开</a></div></body></html>`;

let hud: BrowserWindow | null = null;

export function showControlHud(onDisconnect: () => void): void {
  if (hud && !hud.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    // macOS 上是不激活的 NSPanel:可以点,但不会成为前台 App、不抢键盘焦点。
    type: "panel",
    width: WIDTH,
    height: HEIGHT,
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: area.y + 8,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === DISCONNECT_URL) onDisconnect();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => window.showInactive());
  window.on("closed", () => {
    if (hud === window) hud = null;
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  hud = window;
}

export function hideControlHud(): void {
  if (hud && !hud.isDestroyed()) hud.destroy();
  hud = null;
}

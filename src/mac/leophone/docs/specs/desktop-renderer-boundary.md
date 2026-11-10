# 桌面渲染进程边界：CSP、本地文件打开、中继凭据

状态：Air 开发包已完成；Astra 源码审查补齐文件执行位与真实路径使用规则，待 Pro 生产编译。对应审计项：主窗口缺 CSP、打开外部文件的通道不校验路径和调用方、经中继能取走第三方模型的访问令牌。

## 1. 主窗口 CSP

### 现状
- `packages/desktop/src/renderer/index.html` 没有 CSP。主窗口带完整 preload（`window.zcode`、Host MessagePort），会渲染大量不可信内容（模型回复、Markdown、工具结果、网页预览）。
- 页面里有一段内联启动脚本（启动壳淡出、更新状态窗口跳过启动壳）。

### 规则
- 内联启动脚本移到自有文件 `src/renderer/startupShell.ts`，作为同一入口里先于 `src/main.tsx` 的模块脚本加载，行为不变。主窗口不再有内联脚本，也不依赖 hash 或 nonce。
- 生产构建由 Vite 插件（`apply: "build"`，只处理 `index.html`）注入 `<meta http-equiv="Content-Security-Policy">`。开发模式（Vite dev server、HMR、React Refresh 的内联 preamble）不注入，开发行为不变。
- 策略（生产）：

| 指令 | 值 | 理由 |
| --- | --- | --- |
| `default-src` | `'self'` | |
| `script-src` | `'self' 'wasm-unsafe-eval'` | 只允许打包产物。不放 `'unsafe-inline'` 和 `'unsafe-eval'`。`'wasm-unsafe-eval'` 只允许编译 WebAssembly（shiki oniguruma 引擎），不开放字符串 eval |
| `worker-src` | `'self' blob:` | `@pierre/diffs`、pdf.js worker 是打包文件；库在运行时可能用 blob 起 worker |
| `style-src` | `'self' 'unsafe-inline'` | React 的 style 属性、katex、mermaid、xterm 运行时注入 `<style>`，样式内联有真实需要 |
| `img-src` | `'self' data: blob: file: zcode-media: https: http:` | 启动标志是 data: SVG；Markdown 远程图片；本机媒体走 `zcode-media:` |
| `media-src` | `'self' data: blob: file: zcode-media: https: http:` | 本机音视频预览、远程媒体 |
| `font-src` | `'self' data:` | |
| `connect-src` | `'self' data: blob: file: zcode-media: zcode-sandbox: https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*` | 本机服务、配置的模型服务（https）、插件沙箱协议 |
| `frame-src` | `'self' zcode-sandbox: blob: file: https: http:` | 插件 UI 在 `zcode-sandbox:` 的隔离 frame（自带 header CSP）；网页预览 iframe |
| `object-src` | `'none'` | |
| `base-uri` | `'self'` | |
| `form-action` | `'self'` | |

- 插件 UI、GenUI 继续走现有隔离：独立 `zcode-sandbox:` origin、独立 partition、iframe sandbox，以及 `pluginSandbox/csp.ts` 的逐资源 header CSP。主 frame 不为它们放宽任何脚本权限。
- 其余窗口（resource-manager、cua-permission-panel、leo-quick-panel）本节点不加 CSP，列为后续项。

## 2. 本地文件打开

### 现状
- `OpenExternalFile`（`desktopMainIpcRemote.ts`）、`OpenExternal` 的 `file:` 分支、`OpenInFileManager`（`desktopMainIpcPlatform.ts`）不校验调用方。
- `openPathInDefaultApp` 在 `realpath` 失败后仍用原路径打开，对可执行类型不做拦截。
- macOS 上 `open X.app`、`shell.openPath(X.app)` 都会启动应用；`OpenInEditor` 的 finder 分支对目录调 `shell.openPath`，遇到 `.app` 包同样会启动。

### 规则
- 调用方：这三个通道（以及会按路径启动本机程序的 `OpenInEditor`）只接受应用窗口自己的顶层页面，复用 `isTrustedAppSender`。它就是原来的 `isTrustedLeoSender`，挪到 `trustedAppSender.ts`，`leoLinkIpc.ts` 改为再导出，行为不变。webview 访客、iframe、其他 webContents 一律拒绝。`OpenExternal` 的 http(s) 分支仍按现有规则允许访客使用，这是显式声明的访客通道；只有 `file:` 分支要求可信调用方。
- 解析：`realpath` 失败就返回 `{ success: false, error: "path_not_found" }`，不再尝试打开。
- 判定（`externalFileOpenPolicy.ts`），在真实目标上检查，同时检查调用方给的名字：
  - 应用包或可加载包目录：`.app .appex .prefPane .bundle .framework .plugin .kext .systemextension .xpc .saver .qlgenerator .mdimporter .osax .component .workflow .action .scptd .wdgt`；
  - 可执行、安装包、脚本和快捷方式文件：`.command .tool .terminal .sh .bash .zsh .csh .ksh .fish .scpt .applescript .pkg .mpkg .dmg .jar .jnlp .webloc .inetloc .fileloc .url .desktop .exe .msi .msix .appx .bat .cmd .com .scr .ps1 .vbs .vbe .js .jse .wsf .wsh .hta .lnk .reg .cpl .appimage .run .deb .rpm`；
  - POSIX 平台带执行位的普通文件（不以扩展名是否为空作为豁免；脚本也可能经系统关联启动）。
- 危险目标不打开，改为在访达（文件管理器）里选中显示（`shell.showItemInFolder`），返回 `{ success: true }`，UI 不报错。普通文档、目录照旧用默认应用或文件管理器打开。
- `OpenInEditor` 的 finder/explorer 分支走同一个判定；校验后的打开/定位操作只使用返回的真实路径与真实文件类型，不再使用调用方原始链接。
- 跨平台：只用 `node:path`、`node:url`、`node:fs/promises` 标准库和异步 IO；不碰 workspace identity，路径语义不变。

## 3. 中继取第三方模型访问令牌

### 现状
- `/v1/grok/token` 在 `isLinkPath` 白名单里，`bridge.ts` 会把它转给本机 leoagent，leoagent 返回 grok CLI 的真实 access token。直连入口（`directServer.ts`）已经单独拒绝，中继入口没有。

### 规则
- 从 `isLinkPath` 白名单删除 `/v1/grok/token`，`bridge.ts` 删除转发分支。
- 新增 `isLocalOnlyCredentialPath(pathname)`：反复解码百分号编码（最多 3 次）、统一大小写、把 `\` 当作 `/`、合并重复斜杠、解析 `.` 和 `..`、去掉尾部斜杠，再匹配 `/v1/grok/token`。`bridge.dispatch`（含 `/e2e` 解包后的内层请求）和 `directServer` 都在白名单判断前用它拒绝，返回 404，不暴露接口是否存在。
- leoagent `grok_token`：带 `X-Leo-Caller-Kind` 头（经桥接或中继转发的请求才有这个头），或对端不是本机回环地址（同 WiFi 直连的手机也持本机钥匙），一律返回 403。Mac 本机进程持钥匙调用不受影响。
- 不改 grok CLI 的 `~/.grok/auth.json`，不删 API Key 路径，不改在线服务。手机端「借 Mac 的 grok 登录」改为不可用，手机侧需使用 API Key 或自己的登录。

## 剩余

- 本包按用户最新要求只做源码审查和受影响生产编译，不运行/新增测试、lint、UI/perf 或额外 CI，不安装 Mac 二进制；功能由用户装机后自行确认。
- 如果 Pro 实机发现某个依赖必须 `'unsafe-eval'`，只能按依赖逐个处理，不全局放开。zod 4 会先探测 `new Function` 能否使用，不能用时退回非 JIT 解析，所以不需要放开。
- `'self'` 在 file:// 页面里能否匹配打包产物，靠 Chromium 对 file 协议的处理。Pro 实机要确认主窗口能正常加载；如果被拦，只给 `script-src` 补 `file:`，并记录这样做的风险。
- 其余特权 IPC 的逐个调用方校验（统一注册器）本节点只覆盖了上面四个通道，其余通道留给后续节点。

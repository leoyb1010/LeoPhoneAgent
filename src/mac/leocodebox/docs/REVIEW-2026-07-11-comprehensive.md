# leocodebox v1.1.3 全面审查 · 修复与升级文档

> **文档状态（2026-07-12 标注）**：其中「开启 asar」建议与 docs/SIGNING.md 的有意 asar:false 设计冲突，
> 以 SIGNING.md 为准（A/B 测试通过前不得开启）。包体减重已改走「codex 兜底二进制按需下载」路线
> （2026-07-12 落地，DMG 约 -300MB）。S-2 API Key 哈希化、E-5 单飞互斥、通知管线接通已于 2026-07-12 完成。


> 审查时间：2026-07-11（Asia/Shanghai）
> 审查对象：`cloudcli-native-app`（GitHub 私有仓库 `leoyb1010/leocodebox`），本地优先 macOS 桌面应用
> 代码规模：前端 `src/` 约 5.4 万行（374 TS/TSX）、服务端 `server/` 约 4.2 万行、Electron `electron/` 约 5500 行
> 方法：5 个维度并行深度审查（服务端 / 前端 / Electron / UI 设计动效 / 工程体系）+ 主线亲自核验（typecheck、lint、三套测试、git、npm audit、逐项抽验代码）
> 基线状态：`npm run typecheck` 通过 · `npm test` 通过（server 153 / desktop 12 / client 6）· `npm run lint` 0 error / 249 warning · `npm audit --omit=dev` 7 moderate

---

## 一、总体结论

**这是一套单点工程质量明显高于"AI 长出来的五万行"平均水平的代码**：TypeScript strict、feature 目录纪律、SQL 全参数化、子进程一律数组传参无 shell、文件/git 操作普遍做了 symlink 感知的真实路径校验、Electron 全视图 `sandbox + contextIsolation`、更新凭据走 macOS 钥匙串、token 每次启动轮换。**未发现可被远程直接利用的 P0 漏洞。**

真正的债务集中在四条线，都不是"不会写"，而是"体系没接起来"：

1. **安全纵深有一处真实越权面** —— `/api/agent` 绕过了 UI 侧已有的工作区路径校验，在多 API Key / 自托管场景下等于任意文件读写 + 任意目录代码执行（P1）。
2. **发布链是"有零件、没流水线"** —— 无 CI、release 脚本是死链、husky 质量门禁全部失效、版本降号桥接埋了一颗定时炸弹（下一版就会搁浅 1.36.x 存量用户）。
3. **渲染管线自我抵消** —— WebSocket 每帧广播 + 内联 props 击穿 memo，使精心做的分页/memo 优化在上游被整体废掉；并发会话流式文本会串扰。
4. **视觉半迁移** —— 壳层已有规范 token 体系，但 feature 层仍是上一代裸 Tailwind 调色板（gray/blue/purple 合计 2200+ 处），且一批动画因缺装 `tailwindcss-animate` 静默失效、Electron 启动器品牌色仍是蓝色。

下面按"严重级别总表 → 分域详情 → 修复路线图 → 下一步升级建议"组织。

---

## 二、严重级别总表

| 编号 | 级别 | 域 | 问题 | 证据位置 |
|---|---|---|---|---|
| S-1 | **P1** | 服务端 | `/api/agent` 绕过 `validateWorkspacePath` + 默认 `bypassPermissions`，形成任意文件读写/执行面 | `server/routes/agent.js:872,928` |
| E-1 | **P1** | Electron | BrowserView 无 `will-navigate` 限制，页内导航可跳任意外部站点并寄生在应用壳内 | `electron/viewHost.js:84-92` |
| E-2 | **P1** | Electron | 默认打包链路（不带 `:signed`）静默产出 ad-hoc 签名 DMG + 更新元数据，极易误发布 | `scripts/release/build-signed-mac-dmg.js:24,75`；`package.json` build.mac |
| G-1 | **P1** | 工程 | 版本降号桥接：1.1.4 发布后，仍停留在 1.36.x 的用户将**永久收不到更新** | `electron/updater.js:7-8`；两个 release 脚本硬编码 `1.36.3` |
| G-2 | **P1** | 工程 | `npm run release` / `update:platform` 指向不存在的 `.sh` 脚本；真实发布上传步骤零脚本化 | `package.json` scripts |
| G-3 | **P1** | 工程 | 完全没有 CI（`.github/` 不存在）；171+ 测试全靠手工执行 | 仓库根 |
| G-4 | **P1** | 工程 | husky / lint-staged / commitlint 三件套装了但全部失效（`.husky/` 不存在） | `package.json`；`.husky/` 缺失 |
| G-5 | **P1** | 工程 | v1.1.3 发布 commit 之上堆积 26 改动 + 8 新文件未提交，二进制↔源码可追溯性断裂 | `git status` |
| F-1 | **P1** | 前端 | WebSocket 每帧 `setLatestMessage` 进 context value，导致流式期间近乎全应用重渲染 | `src/contexts/WebSocketContext.tsx:84,170-177` |
| F-2 | **P1** | 前端 | 并发流式会话共享单一缓冲区 `accumulatedStreamRef`，多会话同时输出时文本串扰 | `src/components/chat/hooks/useChatRealtimeHandlers.ts:176-192` |
| F-3 | **P1** | 前端/i18n | 27 个文件硬编码中文绕过 i18next，其余 9 个语言包用户在这些界面看到中文 | `AppearanceSettingsTab.tsx:37-111` 等 27 处 |
| U-1 | **P1** | UI | `animate-in` 系列类全部失效（`tailwindcss-animate` 未安装），Tooltip/右键菜单/Toast 无进入动画 | `tailwind.config.js:86`；7 个 tsx 文件 |
| U-2 | **P1** | UI | 两个陈旧副本文件在库，其一（`switch 2.html`）会被打进产物 | `public/leocodebox-switch 2.html`；`src/contexts/ThemeContext 2.jsx` |
| U-3 | **P1** | UI | Electron 启动器品牌色是蓝色 `#0a66d9`，与主应用 teal 脱节（用户第一眼窗口） | `electron/launcher/launcher.css:27,51` |
| S-2 | P2 | 服务端 | API Key / GitHub token / provider 密钥明文落盘 | `repositories/api-keys.ts:76`；`leocodebox.js:346` |
| S-3 | P2 | 服务端 | 非 local-only 模式 CORS 反射所有来源（`cb(null, true)`） | `server/index.js:157-162` |
| S-4 | P2 | 服务端 | git ref/branch 校验允许前导 `-` 且缺 `--` 分隔，选项注入面 | `server/routes/git.js:51-64,808,857` |
| S-5 | P2 | 服务端 | 会话 watcher 生命周期错位死代码 + 关停时不清理 + 6s 轮询开销 | `server/index.js:1671,1679` |
| E-3 | P2 | Electron | 多数特权 IPC handler 不校验 sender（约 20 个） | `electron/main.js:939-989` |
| E-4 | P2 | Electron | 416MB DMG：两份 build 配置漂移，545MB 厂商 CLI 二进制 + 死依赖全量进包 | `scripts/release/prepare-desktop-app.js:91-102` |
| E-5 | P2 | Electron | `ensureLocalServer` 无互斥，并发可双拉起子进程并泄漏孤儿 | `electron/localServer.js:533-543` |
| F-4 | P2 | 前端 | 零路由/标签级代码分割，CodeMirror+xterm+katex 全在首屏解析路径 | `MainContent.tsx:1-26`；`vite.config.js:52-65` |
| F-5 | P2 | 前端 | token 变更时 WebSocket 重连竞态 → 双连接 | `WebSocketContext.tsx:87-103` |
| F-6 | P2 | 前端 | 错误边界仅 1 处，Git/编辑器抛错白屏整个应用 | `MainContent.tsx:167` |
| F-7 | P2 | 前端 | API 层未统一（28 处绕过封装）；auth token 进 URL query（EventSource） | `src/utils/api.js:121-126` |
| F-8 | P2 | 前端 | 5 个千行级"上帝 hook" + 超宽 props 包，改动成本极高 | `useChatComposerState.ts`(1222 行) 等 |
| U-4 | P2 | UI | 双轨颜色体系：语义 token 与裸调色板并存 1:2（gray 1058 + 彩色 1219 处） | `task-master/`、`chat/tools/`、`mcp/` 等 |
| U-5 | P2 | UI | 29 个手写弹窗绕过共享 Dialog，a11y 与动画双缺失；遮罩/z-index 失控 | 29 个文件；`McpServerFormModal.tsx:124` |
| G-6 | P2 | 工程 | 7 个 audit 漏洞全来自从未使用的 `nut-js`/`screenshot-desktop` | `package.json` optionalDependencies |
| G-7 | P2 | 工程 | API 文档覆盖率约 5%（19 组路由只写 1 个）+ 端口写错（3001 vs 38473）+ 依赖 CDN | `public/api-docs.html` |
| — | P3 | 多域 | 见各分域"P3/卫生问题"清单（字号/对比度/死 token/死代码/命名等约 30 项） | 详见下文 |

---

## 三、分域详情

### 3.1 服务端（`server/`）

**做得好**：认证分三态（local-only 令牌 timing-safe / platform / OSS-JWT）清晰；文件与 git 普遍做 symlink 感知真实路径校验；子进程数组传参无 shell；SQL 全参数化；密钥在响应中脱敏；DB 目录 0700/文件 0600。

**S-1（P1）任意文件读写/执行面**
UI 建项目走 `createProject → validateWorkspacePath`（限制在 `WORKSPACES_ROOT`/家目录内）；但 `/api/agent` 直接 `projectsDb.createProjectPath(finalProjectPath, null)`，`finalProjectPath` 来自请求体且**未过** `validateWorkspacePath`。注册后拿到 `projectId`，文件 API 仅校验"在 project_path 之内"，而 project_path 此时可为 `/`、`/etc`、任意家外目录 → 可读写全盘；且 headless 默认 `bypassPermissions`（`agent.js:872`）在任意目录以完全权限跑 CLI。单用户本地模式风险有限，但自托管 / 分发 API Key 场景是真实越权。
- **修复**：`/api/agent` 注册前对 `projectPath` 调 `validateWorkspacePath`；文件 API 侧对解析出的 root 追加一次 `assertRealPathWithinRoot(WORKSPACES_ROOT, root)` 兜底；headless 默认权限改 `acceptEdits` 或强制显式声明。

**S-2（P2）密钥明文落盘**：`api_keys`、GitHub token、`~/.leocodebox/switch/providers.json` 均明文；`validateApiKey` 用 `WHERE api_key = ?` 明文等值比较。→ API Key 至少存 SHA-256 哈希后按哈希查；provider/GitHub 密钥用 OS keyring 或对称加密。

**S-3（P2）CORS**：`origin: (o,cb)=>cb(null, IS_LOCAL_ONLY_AUTH ? isLoopbackOrigin(o) : true)` —— 非 local-only 对任意来源回显 ACAO。→ 配来源白名单，勿无条件 `true`。

**S-4（P2）git 选项注入面**：`validateCommitRef`/`validateBranchName` 允许前导 `-`；`git show/checkout/branch -d` 未加 `--`。无 shell 故非命令注入，但值可被当选项解析。→ 正则禁前导 `-`，统一插 `--`。

**S-5（P2）watcher 生命周期**：`index.js:1679` 的 `await closeSessionsWatcher()` 在 `initializeSessionsWatcher`（1671 listen 回调内）之前同步执行，是错位 no-op 死代码；真正关停 `shutdownRuntimeServices` 从不调用它 → watcher 退出不关闭（靠 `process.exit` 由 OS 回收）。且 `usePolling:true, interval:6000` 对 4 目录 depth=6 轮询有持续 CPU/IO。→ 删 1679、把关闭挪进 `shutdownRuntimeServices`、评估改用 fsevents。

**P3/信息**：登录无限流（`auth.js:116`，全仓无 rate-limit/helmet）；REST 接受 `?token=`；插件安装 `--ignore-scripts` 后又 `npm run build` 等于任意代码执行；`commandParser.js` 允许清单偏弱但当前未接线；`/health` 预认证暴露版本；`index.js:446` 文本文件全量入内存无上限。

**架构一致性**：`.js` 路由（手写 try/catch）与 `.ts` 模块（`AppError + asyncHandler`）两套约定割裂；`index.js`（1721 行）内联全部文件端点未模块化；**路径校验重复 5+ 份**、loopback 判定/GitHub URL 解析/CLI spawn 逻辑各自复制多份，强度参差。

### 3.2 前端（`src/`）

**做得好**：strict TS、`any` 仅 41 处、feature 目录纪律；`useSessionStore` 的 fetch ticket 防竞态（`_fetchSeq/_appliedFetchSeq`）是全仓最高质量代码；聊天区 `contain`/`content-visibility` 性能处理、`MessageComponent` 的 WeakMap 稳定 key 设计考究；事件监听器清理整体合格。

**F-1（P1）每帧全局重渲染**：`dispatch()` 对每一帧 WS 消息 `setLatestMessage(event)`，而 `latestMessage` 在 context value 的 `useMemo` 依赖里 → 所有 `useWebSocket()` 消费者每帧重渲染。连锁：`Sidebar` 未 memo（整个侧栏子树每帧重渲）；`MainContent` 的 memo 被 `AppContent.tsx:287,293-298` 内联箭头 props 击穿；`ChatComposer`(615 行) 完全未 memo。代码注释自承 `latestMessage` 是 legacy 仅供低频 TaskMaster。→ 把 `latestMessage` 移出 context value（TaskMaster 迁到 `subscribe`），或拆两个 context；给 Sidebar 加 memo、内联回调 `useCallback` 化。**此一项收益最大。**

**F-2（P1）流式串扰**：`accumulatedStreamRef` 跨会话共享单字符串缓冲，100ms 定时器闭包捕获首帧 `sid`。多会话并发流式时 B 的文本混入 A 的气泡。→ 改 `Map<sessionId,{buffer,timer}>` 按会话隔离。

**F-3（P1）i18n 绕过**：配了完整 react-i18next + 10 个语言包，但设置页、侧栏底部、认证流程、错误提示整块硬编码中文（27 文件）。→ 补 key，或明确放弃多语言删掉 9 个包——当前是最差中间态。

**P2**：F-4 零 `React.lazy`；F-5 重连竞态双连接（onclose 未比对 `wsRef.current===websocket`）；F-6 错误边界仅 1 处；F-7 API 层 28 处绕过封装 + token 进 URL query（EventSource 无法带 header → 建议短时一次性 ticket）；F-8 `useChatComposerState`(1222)/`useProjectsState`(1104)/`useSidebarController`(998)/`useChatSessionState`(862)/`useGitPanelController`(820) 五个上帝 hook 靠几十个 props+ref 缝合；F-9 消息列表无虚拟化、流式 Markdown 每 100ms 全文重解析；F-10 WS 订阅 effect 依赖高频 state 反复重建监听。

**P3**：`ThemeContext 2.jsx` 废文件；`DEFAULT_PROVIDER` 两处缺省不一致（`codex` vs `claude`）；provider 显示名三元重复 14 处；`fetchProjects` 无 AbortController；`localStorage` 直接访问 113 处与 `useLocalStorage` 并存。

### 3.3 Electron（`electron/` + 发布脚本）

**做得好**：全视图 `contextIsolation:true / nodeIntegration:false / sandbox:true`；preload 按 origin 分级最小暴露 + `Object.freeze`；`shell.openExternal` 协议白名单；权限 handler 白名单；tar 解包路径穿越校验；`GH_TOKEN` 双向剔除；子进程按进程组 `SIGTERM→SIGKILL` + `process.kill(-pid)` 清理 + server 侧 parent watchdog 兜底；单实例锁；端口冲突回退；签名/公证管线（逐个 Mach-O 签名、staple、spctl 校验、notary 走钥匙串）质量高于 electron-builder 默认路径。

**E-1（P1）BrowserView 无导航限制**：全仓 `will-navigate` 零命中。`setWindowOpenHandler` 只拦 `window.open`/`_blank`，普通 `<a target=_self>`、`location.href`、服务端 302 都会让 BrowserView 导航到任意外部站点并停在无地址栏的应用壳内 → 钓鱼/界面伪装。本地页面渲染 agent 产出内容，源不完全可信。→ `configureChildWebContents` 加 `will-navigate`/`will-frame-navigate`：非同源 `preventDefault()` 转 `openExternalUrl`。

**E-2（P1）ad-hoc 误发布**：`npm run desktop:dist:mac`（不带 `:signed`）在签名身份为空时静默 `codesign --sign -`（ad-hoc，且此分支未加 `--options runtime`），却照常生成 `latest-mac.yml` + ZIP。若上传：其他 Mac Gatekeeper 拒开 + Squirrel 签名连续性校验失效。→ 未设签名身份时给产物加 `-unsigned` 后缀并**拒绝生成** feed/ZIP；流水线强制 `:signed` + notarize。

**P2**：E-3 约 20 个特权 IPC handler 不校验 sender（`run-active-environment-action('ssh')`、`get-state` 泄露完整 PATH/CLI 路径/主目录），仅少数调了 `requireTrustedLocalIpcSender`；E-4 见下"体积"；E-5 `ensureLocalServer` 无单飞 promise，启动等待期并发点击可覆盖 `ownedServerProcess` 泄漏孤儿。

**E-4 / 体积拆解（实测打包产物 `Resources/app/node_modules` 761MB）**：
- `@openai/codex-darwin-arm64` **297MB** + `@anthropic-ai/claude-agent-sdk-darwin-arm64` **226MB**：根 `package.json` build.files 有 `!**/claude-agent-sdk-{darwin,...}-*/**` 排除，但 `prepare-desktop-app.js` 生成的 staged 配置**丢了该排除项**，codex 平台包从未排除。
- `lucide-static` **60MB**：全仓零 import，纯死依赖。
- `lucide-react`(32M)/`react-syntax-highlighter`(8.7M)/`katex`/`@codemirror/*`/`@xterm/*` 等纯前端依赖已被 vite 打进 `dist/`(7.4MB)，node_modules 原件冗余约 60MB+。
- **路线（417MB → 预计 <90MB）**：① 恢复并扩展 staged 排除项，剔除两个厂商平台包（应用本就用 runtimePath 探测用户已装 CLI，兜底可复用 serverInstaller 按需下载）；② 删 `lucide-static`；③ 拆 server/client 依赖，staged 只带 server 闭包；④ 开 `asar:true`（native 模块 asarUnpack）。

**P3**：launcher CSP 过宽（`connect-src *`）；updater 把 404 误判为认证失败 + `Promise.race` 超时不取消底层请求；`serverInstaller.js` 死代码；BrowserView 应规划迁 `WebContentsView`；每条启动日志重建菜单+托盘；无 `render-process-gone` 处理；`saveGithubToken` 的 `0o600` 仅首次创建生效。

### 3.4 UI 设计系统与动效

**做得好**：壳层 token 体系规范（HSL 语义变量、`--nav-*` 子系统、`data-accent` 切换、密度/减动效开关）；深浅主题行级覆盖近乎完整；reduced-motion 三重保障；`placeholder.html` 启动页动画是全项目最佳实践；共享 Dialog 焦点陷阱/还原完整。

**P1**：U-1 `animate-in fade-in/zoom-in/slide-in` 类因 `tailwindcss-animate` 未装全部不生成 CSS（7 个 tsx，Tooltip/右键菜单/Toast 硬弹出）；U-2 `leocodebox-switch 2.html`(旧版，会打进 public 产物) + `ThemeContext 2.jsx`(硬编码 `#141414` 与现行不一致) 应删；U-3 launcher 品牌色蓝 `#0a66d9`（`placeholder.html` 已正确用 teal，证明是遗漏）。

**P2**：U-4 gray 1058 + 彩色调色板 1219 处与 token 1:2 并存（`TaskEmptyState.tsx` 同一空态出现 blue 与 purple 两种"主色"，与 teal 无关）；U-5 29 个手写 `fixed inset-0` 弹窗仅 6 处有 `role=dialog`，共享 Dialog 只 5 文件在用，遮罩透明度 7 种、z-index 从 `z-50` 到 `z-[10000]` 失控；另：checkbox/radio 全局强制蓝色（`index.css:430`）；字体死配置 `font-serif` 落 Georgia 致中英混排撕裂；浅色主按钮对比度约 4.1:1 不达 AA。

**P3**：动效 duration 11 种 / easing 4 曲线无 token；`text-[10px]` x63 等微字号滥用 + 44 行 `text-gray-400` 浅色 2.8:1；`--leocodebox-density-scale` 死 token；`index.css` spin 定义 3 次 + 120 行 `!important` placeholder 补丁；focus-visible 仅 11 处而 `focus:ring` 102 处；`api-docs.html` 英文+蓝色+无深色+依赖 CDN。

### 3.5 工程体系

**做得好**：`.gitignore` 锚定根目录到位（700 跟踪文件 0 构建产物）；签名/公证管线工程质量高；updater 桥接有 12 个测试覆盖；更新 token 走 safeStorage + 0600。

**P1**：G-1 版本桥接（latest-mac.yml 写 `1.36.3`、CFBundleVersion 改写、updater 屏蔽桥接版本）只在 1.1.3 是最新 Release 期间有效；发 1.1.4 后 feed 回真实 semver，`1.1.4 < 1.36.2` 且 `allowDowngrade=false` → 1.36.x 用户永久搁浅且无告警，且 1.2.0–1.36.3 整段版本号已烧毁不可复用。G-2 `release.sh`/`update-platform.sh` 均不存在（死链），真实发布=`desktop:dist:mac:signed`→`notarize`→**手工上传** DMG/ZIP/yml，少传一个则应用内更新静默失效。G-3 无 CI。G-4 husky/lint-staged/commitlint 死配置。G-5 发布 commit 之上 26 改 + 8 新未提交。

**P2**：G-6 7 audit 全来自零引用的 `nut-js`/`screenshot-desktop`（删除即清零 + 减重）；G-7 api-docs 覆盖约 5% + 端口 3001 错（实际 38473）+ 依赖 cdnjs（与"本地优先"冲突），且设置页 `ApiKeysSection.tsx:47` 有可见链接；另：git 历史仅 8 commit（被重置）本地/远端 tag 不同步；无 CHANGELOG 而三个变更日志工具装而不用；`node-fetch@2` 零引用；无 `engines`/`.nvmrc`（node-pty/better-sqlite3 对 Node 版本极敏感）。

**P3**：README 命名倒置（`README.md` 是中文主文档、`README.zh-CN.md` 反而是摘要，无英文完整文档）；`private:true` 下 `files`/`bin`/`prepublishOnly` 死配置；`test:client` 只写死 2 文件漏 1 个；src 384 源文件仅 3 测试（覆盖约 0.8%）；`test:clean-device` 好用但不在 `npm test` 也无 CI 承载。

---

## 四、修复路线图（按投入产出排序）

### 第一周 · 止血（安全 + 发布定时炸弹）
1. **S-1**：`/api/agent` 强制 `validateWorkspacePath` + 文件 API root 兜底 + headless 默认权限降级。（安全，最高优先）
2. **G-1**：发 1.1.4 前确认存量 1.36.x 迁移情况，或同时附 `1.36.4` 桥接元数据；桥接常量收敛到单一模块两脚本共享；README 写明禁用区间 1.2.0–1.36.3。
3. **E-2**：未设签名身份时禁止生成 feed/ZIP 并加 `-unsigned` 后缀。
4. **G-3**：加最小 GitHub Actions（macos runner）`npm ci && typecheck && lint && test`——当前性价比最高的单项投入。
5. **G-5**：把 WIP 提交到分支；确立"发布 commit 必须 clean tree + tag"纪律；`git fetch --tags` 同步。
6. **E-1**：BrowserView 加 `will-navigate` 外链拦截。
7. **U-1 + U-2**：装 `tailwindcss-animate`（或在 config 补 keyframes）；删两个 `* 2.*` 副本文件。（半小时）

### 第二周 · 减重 + 清死配置
8. **E-4**：staged 排除项恢复 + 删 `lucide-static` + 依赖拆分 + `asar:true`（417MB→<90MB）。
9. **G-6**：删 `nut-js`/`screenshot-desktop` → audit 清零 + 减重。
10. **G-2**：写真正的 `scripts/release/release.sh` 端到端编排（版本校验→构建→签名→公证→`gh release create` 上传三产物→打 tag）。删死 script。
11. **G-4**：补齐 husky（`npx husky init` + pre-commit 跑 lint-staged + commit-msg 跑 commitlint）或整体删除三依赖。
12. **F-1**：`latestMessage` 移出 context value + Sidebar memo + 内联回调 useCallback 化。（渲染性能，收益最大）
13. **F-2**：流式缓冲改按会话隔离 Map。
14. **U-3**：launcher.css 品牌色换 teal 双主题；文案统一中文。

### 第一个月内 · 结构与体验
15. **S-2**：API Key 哈希存储；provider/GitHub 密钥加密。
16. **S-3 / S-4 / S-5 / E-3 / E-5**：CORS 白名单、git `--` 分隔、watcher 关停接线、IPC sender 统一守卫、`ensureLocalServer` 单飞 promise。
17. **F-3**：硬编码中文清零（脚本化扫描 + 按文件分批）。
18. **F-4 / F-6**：Settings/GitPanel/editor/Shell 懒加载 + 错误边界补齐。
19. **F-7**：API 层 TS 化 + 强制走 `api` 对象 + token 移出 URL（改一次性 ticket）。
20. **U-4 / U-5**：状态色 token 化（`--success/--warning/--info`）+ 主 CTA `bg-blue-600`→`bg-primary` + 手写弹窗分批迁共享 Dialog + z-index 阶梯 token。
21. **G-7**：重写 api-docs（按实际路由 + 修端口 + 本地化 Prism），或摘掉设置页链接。
22. **G-5+**：启用 release-it 生成 CHANGELOG；`test:client` 改 glob 发现；`node-fetch` 删除；加 `engines`+`.nvmrc`。

### 季度 · 架构演进
23. **F-8**：聊天域状态收敛为 zustand 类 store，拆解 `useChatComposerState`，砍 prop 隧道（建议随下一个聊天功能迭代顺带做，避免纯重构冻结期）。
24. **F-9**：长会话虚拟列表 + 流式 Markdown 增量渲染。
25. 服务端：路径/来源/工作区校验收敛为 `shared/` 单一实现；`index.js` 文件端点模块化 + 统一 `AppError + asyncHandler`；CLI spawn 逻辑收敛。
26. 前端覆盖率从 0.8% 提升（关键 hook 与 store 优先补测）。

---

## 五、下一步升级建议（系统完整性 / 连贯性 / UI / 动效）

### 5.1 系统完整性
- **发布可靠性是当前最大缺口**：CI（G-3）+ 端到端 release 编排（G-2）+ 版本策略修复（G-1）三件事完成后，"发布可靠性"才能与"代码质量"匹配。这是全局第一优先。
- **安全从"本地够用"到"可安全自托管"**：把路径/来源/工作区校验收敛成单一实现并让所有入口（尤其 `/api/agent` 与内联文件端点）强制经过（S-1）；密钥哈希/加密（S-2）；IPC sender 统一守卫（E-3）。完成后可对外宣称自托管安全。
- **可观测性**：目前无结构化日志/错误上报。本地优先产品可加一个"本机诊断导出"（脱敏后的日志 + 版本 + CLI 探测结果 zip），既帮排障又不违背隐私定位。

### 5.2 连贯性
- **版本号叙事修复**：1.36.x→1.1.3 降号 + git 历史重置叠加，任何"哪版引入"问题都答不了。从现在起严格一 release 一 tag 一 commit + CHANGELOG。
- **文档归位**：README.md 转英文承载国际 keywords，中文全文进 README.zh-CN.md；docs/ 分离"过程性审计报告"与"长期文档"；补 CONTRIBUTING/开发指南。
- **单一真相源**：provider 缺省值（F-P3）、loopback/路径校验/CLI spawn（服务端重复）、版本桥接常量（G-1）都应收敛到唯一模块，消除"多份实现强度参差"。

### 5.3 UI / 设计系统
1. 建立**状态色 token**（`--success/--warning/--info/--danger` 双主题）并注册进 tailwind config，先替换所有主 CTA 裸蓝/裸紫 → `bg-primary`，成功态 emerald/green → `--success`。这一步消掉约六成裸色。
2. checkbox/radio `accent-color: hsl(var(--primary))`，删 `index.css` dark 硬编码 rgb。
3. 浅色 `--primary` L 降至 29%（主按钮达 AA）；浅色辅助文字底线 `text-muted-foreground`，禁用裸 `text-gray-400`；9px 以下字号清零，10/11px 收敛为一档 `text-2xs`。
4. 29 个手写 modal 分批迁共享 Dialog（优先 MCP、task-master 高频）；遮罩统一 `bg-black/50 backdrop-blur-sm`；z-index 阶梯 token（overlay 50 / modal 60 / popover 70 / toast 80），禁 `z-[9999]` 类任意值。
5. 字体配置落地：`font-sans` 对齐 body 系统栈（含 PingFang SC）；聊天正文 serif 建议改回 sans，中英混排更统一。
6. `api-docs.html` 按 `feedback` 页范式重做（teal + data-theme 双主题 + zh-CN + 本地化 Prism）；launcher 与 api-docs 品牌归队。

### 5.4 动画动效
- **动效 token 化**（当前 11 种 duration / 4 曲线无规范），建议规范：
  - duration 三档：`--motion-fast: 120ms`（hover/press）、`--motion-base: 180ms`（展开/切换/弹窗）、`--motion-slow: 280ms`（页面级进入/大位移）；
  - easing 两条：`--ease-out: cubic-bezier(0.2,0,0,1)`（进入，保留现有品牌曲线）、`--ease-in: cubic-bezier(0.4,0,1,1)`（退出）；
  - 位移幅度统一 4–8px。注册为 Tailwind `transitionDuration/transitionTimingFunction` 扩展。
- **加载态体系**：目前只有 spinner + pulse，无骨架屏。基于现有 Shimmer 加 `<Skeleton>`，优先落地项目列表 / 会话列表 / git 历史三个冷启动等待面。
- **空状态模板化**：以 design-qa 的"紧凑三步指引"为标准组件（icon + 标题 + 一句话 + 单一主 CTA），重做 `TaskEmptyState` 类蓝紫渐变旧版空态。
- **微交互机会点**（token 化之后）：会话列表 hover 操作按钮 fade+slide 进入（现为突现）；状态栏数字 `tabular-nums` 滚动过渡；`rail-button` 的 translateY 微弹推广到 PillBar 与 tab 切换；聊天发送按钮 press `scale(0.96)` 反馈。
- 尊重现有 reduced-motion 三重保障，所有新动效必须在 `data-reduce-motion` 下降级。

---

## 六、验证基线（本次实跑）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 通过（两套 tsconfig） |
| `npm test`（desktop+client+server） | ✅ server 153 / desktop 12 / client 6 全过 |
| `npm run lint` | ⚠️ 0 error / 249 warning（无 ratchet，会持续膨胀） |
| `npm audit --omit=dev` | ⚠️ 7 moderate（全来自零引用可选依赖，删除即清零） |
| git 工作区 | ⚠️ 发布 commit 之上 26 改 + 8 新未提交 |

---

*本文档由 5 维度并行深度审查 + 主线逐项代码核验生成，所有 P0/P1/P2 发现均引用真实文件行号并经抽验属实。修复建议按投入产出排序，可直接作为迭代 backlog 使用。*

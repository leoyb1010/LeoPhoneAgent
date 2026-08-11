# Review：本机智能体一键更新缺口 + 全项目可升级项

> 审查对象：leocodebox v1.38.0（main @ 06a1946，工作区干净）
> 审查日期：2026-07-12。两个 `tsc --noEmit` 均 0 错误，基线健康。
> 结论先行：**"设置 → 智能体 → CLI 工具"里的一键更新，在本机 6 个 CLI 中只有 codex、opencode 两个能真正一键更新**。其余 4 个（Claude Code、Gemini、Cursor、Hermes）因为下面 A1–A4 的组合原因，按钮根本不会出现。

---

## 一、本机实测（问题的直接证据）

在本机对 `detectCliInstallSource` 的正则逐一复算真实安装路径，结果：

| CLI | 实际可执行文件（realpath） | 被判定为 | 能否一键更新 | 原因 |
|---|---|---|---|---|
| Claude Code | `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/...` | `homebrew` ❌误判 | **不能** | A1：homebrew 正则先于 npm-global 命中；formulaById 无 claude |
| Codex | `~/.local/lib/node_modules/@openai/codex/...` | `npm-global` ✅ | 能 | — |
| OpenCode | `~/.local/lib/node_modules/opencode-ai/...` | `npm-global` ✅ | 能 | — |
| Cursor | `~/.local/share/cursor-agent/versions/...` | `unknown` ❌ | **不能** | A2 + A3 双重死锁 |
| Gemini CLI | `/opt/homebrew/lib/node_modules/@google/gemini-cli/...` | `homebrew` ❌误判 | **不能** | 同 Claude（A1） |
| Hermes | `~/.local/bin/hermes` | `standalone` | **不能** | A4：updateArgs 为 null |

更新按钮的显示条件是 `installed && runnable && updateAvailable && canSelfUpdate`（[CliToolsSection.tsx:158](../src/components/settings/view/tabs/agents-settings/CliToolsSection.tsx)），任何一环断掉按钮就直接消失、**且不给任何解释**——这就是"不能一键更新、也没有快捷更新入口"的体感来源。

---

## 二、根因清单（按严重度排序）

### A1【critical】homebrew 正则遮蔽 npm-global，误判后又无 formula 映射

[cli-tools.routes.ts:118](../server/modules/leocodebox/cli-tools.routes.ts)：`detectCliInstallSource` 先匹配 `(Cellar|homebrew)` 再匹配 `lib/node_modules`。用 Homebrew 版 Node 做 `npm install -g` 时，产物路径 `/opt/homebrew/lib/node_modules/...` 同时含两个特征，被抢先判成 `homebrew`。随后 [resolveCliUpdateCommand:144](../server/modules/leocodebox/cli-tools.routes.ts) 的 `formulaById` 只映射了 `opencode`，claude/codex/gemini 全部返回 null → `canSelfUpdate=false` → 无按钮。

**修法**：① 把 `lib/node_modules` 判定移到 homebrew 之前（真正的 brew formula 装在 `Cellar/`，不含 `lib/node_modules` 段），或把 homebrew 正则收紧为 `Cellar|Caskroom`；② `formulaById` 补全 `gemini-cli`、`codex`、`claude-code`（cask 需 `brew upgrade --cask`）。

### A2【critical/high】无 npm 版本源的工具永远不出更新按钮，还误显"已是最新"

cursor、hermes 的 `npmPackage: null` → [readCliLatestVersion:198](../server/modules/leocodebox/cli-tools.routes.ts) 返回 `unsupported` → `latestVersion` 恒 null → `updateAvailable` 恒 false → 按钮永不出现。更糟：前端 [CliToolsSection.tsx:127](../src/components/settings/view/tabs/agents-settings/CliToolsSection.tsx) 把"检查失败/不支持检查"和"确实最新"都渲染成**绿色"已是最新"徽章**，属于误导性显示。

**修法**：① 对 `canSelfUpdate=true` 但版本不可知的工具改为显示"检查并更新"按钮（`cursor-agent update` 自身幂等）；② `latestVersionSource` 为 `unsupported/unavailable/skipped` 时显示灰色"无法检查"中性徽章；③ 长期可为 cursor/hermes 接入 GitHub releases 等版本源。

### A3【high】安装来源检测覆盖不全

`~/.local/share/cursor-agent`（cursor 官方安装器）、`~/.opencode/bin`（opencode 官方脚本）、`~/.bun/bin`、`.asdf/shims`、mise shims、deno 等常见形态全部落入 `unknown`。`standalone` 正则只认 `.local/(bin|share/claude)`（[cli-tools.routes.ts:133](../server/modules/leocodebox/cli-tools.routes.ts)），对 claude 之外的官方安装器一概不认。

**修法**：扩充判定表（`.local/share/<cmd>`、`.opencode/bin` → standalone；`.bun/` → bun 源，`bun add -g <pkg>@latest`），unknown 时返回 `manualHint` 手动命令字段。

### A4【high】standalone 分支依赖 updateArgs，但多数工具没配

opencode 实际有 `opencode upgrade`、hermes 有自更新子命令，但配置里 `updateArgs: null`（[cli-tools.routes.ts:64,90](../server/modules/leocodebox/cli-tools.routes.ts)）→ standalone 来源也无法自更新。cursor 配了 `updateArgs` 却因 A3 的来源误判永远走不到这个分支。

**修法**：`opencode.updateArgs = ['upgrade']`、`hermes.updateArgs = ['update']`。

### A5【high】LOCAL_ONLY 门禁与 UI 不一致：按钮显示、点击必 403

POST `/:id/update|install` 要求 `LEOCODEBOX_LOCAL_ONLY==='1'`（[cli-tools.routes.ts:308](../server/modules/leocodebox/cli-tools.routes.ts)），该变量只有 Electron 桌面端设置（[electron/localServer.js:402](../electron/localServer.js)）；`server/cli.ts`、`npm run dev`、`npm run server` 均不设置。但 GET `/status` 不校验它，`canSelfUpdate` 照常为 true → 非桌面形态下按钮照常显示，点击必然 403。

**修法**：`/status` 返回 `mutationsAllowed` 字段，前端据此把按钮渲染为禁用态 + tooltip"仅桌面本机模式可用"。

### A6【high】Windows 全链路失效

`resolveExecutablePath` 硬编码 `which`（Windows 无此命令）→ 来源永远 unknown → Windows 上没有任何工具能一键更新；且 `execFile` 不走 shell，无法执行 `claude.cmd` 这类 npm 包装脚本。项目有 `desktop:dist:win`，Windows 是正式支持目标。

**修法**：win32 分支用 `where` + PATHEXT（electron/runtimePath.js 已有跨平台查找实现，抽成共享模块复用即可）；`.cmd/.bat` 用 `shell: true` 执行。

### A7【medium】有新版但不能自更新时，UI 零指引

`updateAvailable && !canSelfUpdate` 时按钮直接消失，不显示 docsUrl、不显示手动命令、不解释原因。用户只看到黄色"有更新"徽章却无处可点。

**修法**：这种状态下渲染禁用按钮或"手动更新"入口：展示 installSource 对应的可复制命令（`brew upgrade x` / `npm i -g x@latest`）+ docsUrl 链接。

### A8【medium】更新体验问题

- 更新超时 180s（install 却是 300s），`brew upgrade` 极易被 SIGTERM 杀死且无提示"被超时终止"（[cli-tools.routes.ts:330](../server/modules/leocodebox/cli-tools.routes.ts)）；
- 失败时服务端返回的 `output`（npm/brew 报错原文）被前端完全丢弃，只显示一行 message；
- `npm i -g` 在需 root 的全局前缀下 EACCES 失败无针对性指引；
- 无"全部更新"按钮；更新成功后 `load(true)` 强刷全部工具 + 绕过 24h 缓存，代价高；
- 每次切回设置页都全量重查（无模块级缓存）、加载无骨架屏；
- 有更新时应用内零主动曝光（无角标/通知），只有翻到设置深处才能看到。

### A9【medium】版本比较与网络层缺陷

- `compareSemver` 不处理预发布段：正式版发布后可能不提示更新（[version-network.utils.ts](../server/modules/leocodebox/version-network.utils.ts)）；
- `fetchJson` 不支持代理（HTTPS_PROXY 不生效）、registry 硬编码 npmjs.org 不读 npm 镜像配置——受限网络下版本检查必然失败，且失败原因不透传给前端；
- `CLI_VERSION_TOKEN` 取全文第一个数字 token，有误匹配风险。

---

## 三、其他可升级项

### B1【high】应用自身的自动更新被 GitHub Token 卡死

electron-updater 链路完整（[electron/updater.js](../electron/updater.js)、main.js），但 feed 指向**私有** GitHub Releases，必须手填 GH_TOKEN 才能检查更新——普通用户等于没有应用自更新。updater.js:119-124 已支持 generic provider（`LEOCODEBOX_UPDATE_URL`）。
**建议**：公开 releases，或架一个公开静态更新源（latest-mac.yml/latest.yml + zip）并内置为默认 feed。

### B2【medium】三个"名不符实"的更新入口

- `leocodebox update` CLI 子命令只检查不更新，且检查也需要 GH_TOKEN（[server/cli.ts:267](../server/cli.ts)）；
- 服务端 `/updates/check`（feedback-update.routes.ts）是无人调用且必然 404 的死接口，Web/远程模式没有任何更新提示；
- README 对更新行为的描述与实现不符。

### B3【medium】插件与运行时更新能力缺失

- git 插件只有"盲更"无"更新可用"检测，且 install/update/delete **未套 LOCAL_ONLY 门禁**，与 cli-tools 安全基线不一致（[server/routes/plugins.ts:177](../server/routes/plugins.ts)）——建议抽 `requireLocalOnly` 公共中间件统一；
- browser-use 的 Playwright/Chromium 运行时只装不更、`--no-save` 装法版本不可追踪。

### B4【low】依赖升级

- 前端栈落后一个大版本：React 18 → 19、react-router 6 → 7、Tailwind 3 → 4（建议分三次独立升级）；
- `@types/express@^5` 与 `express@^4` 主版本不匹配（对齐为 ^4.17 类型，或升 express 5）；
- concurrently ^8→9、node-gyp ^10→11 等 devDeps 可顺手升。

### B5【low~medium】工程质量

- **测试缺口**：install/update 两条路由零测试（403 门禁、404/409、来源分支、超时分支全部未覆盖）；`leocodebox-cli.test.ts` 仅测 4 个纯函数；唯一端到端烟测 `test-clean-device.mjs` 只打 /status 且不在 CI；
- `LEOCODEBOX_TEST_HOME` 是能在生产放开命令执行门禁的测试后门，建议限定 `NODE_ENV==='test'`;
- `CLI_TOOLS[req.params.id]` 原型链查表（`__proto__` 会 500 而非 404），用 `Object.hasOwn` 校验；
- 服务端用户可见错误中英文混杂未走 i18n（建议返回错误 code 由前端渲染；`agents.cliTools.*` 前端 24 个 key 已核对 10 个 locale 完整无缺）;
- 死代码：`SettingsMainTabs.tsx`、`AgentListItem.tsx` 未被引用；OpenCode 的"权限"分类是整页空白；
- CLI 更新功能零文档：docs/ 与 api-docs.html 均未收录 `/api/leocodebox/cli` 三个端点。

---

## 四、建议的修复顺序（最小改动 → 最大收益）

1. **一天内可完成、直接解决用户抱怨**（改 cli-tools.routes.ts 一个文件为主）：
   - 调换 npm-global / homebrew 判定顺序（A1）；
   - `formulaById` 补全 3 个 formula（A1）；
   - `opencode/hermes` 补 updateArgs，standalone 正则补 `.local/share/cursor-agent`（A3/A4）；
   - 无版本源工具放宽为"检查并更新"按钮，绿色徽章改三态（A2）。
   仅这四条就能让本机 6 个 CLI 全部获得一键/快捷更新入口。
2. **一周内**：/status 增加 `mutationsAllowed`（A5）、失败时展示 output、超时统一 300s（A8）、`manualHint` 手动命令降级 UI（A7）、compareSemver 预发布修正 + 代理支持（A9）、补 install/update 路由测试（B5）。
3. **中期**：Windows 支持（A6）、应用自更新公开 feed（B1）、更新可用角标（A8）、插件门禁统一（B3）、依赖大版本升级（B4）。

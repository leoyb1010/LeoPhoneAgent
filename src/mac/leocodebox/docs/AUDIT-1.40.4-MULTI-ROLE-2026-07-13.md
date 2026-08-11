# leocodebox v1.40.4 多角色对抗审计

审计日期：2026-07-13<br>
审计对象：`main` / `ce274af` / `v1.40.4`<br>
结论：**不建议把当前代码直接认定为“每台设备开箱即用”的最终稳定版。正式 App 可启动、免登录、签名公证有效，但仍有 5 项发布阻断或高风险问题。**

## 一、更新扫描摘要

相对 `v1.39.4`，当前版本修改 82 个文件，约 `+2810/-1374`，主要升级为：

1. 重写桌面本地服务启动与 CLI 发现，支持多副本识别和更新路径锚定。
2. Leoapi 对 Claude Code、Codex 会话增加当前接口环境覆盖，避免 shell 旧变量抢占。
3. 加入 Agent 诊断、版本检测、Codex 缺失时的运行组件下载与命令面板联动。
4. 修复新会话首条实时消息不显示，并补充对应回归测试。
5. 完善正式 DMG、热更新、签名、公证和发布文档。

## 二、阻断项与高风险发现

### P1-1 全新设备验收测试失败，跨设备结论目前不成立

`npm run test:clean-device` 实际失败：期望隔离环境中的 Claude `9.1.1`，却读取到宿主机真实版本 `2.1.207`。

原因是测试把模拟 CLI 放进 `LEOCODEBOX_AGENT_PATH`，但新版发现逻辑只优先使用 `LEOCODEBOX_LOGIN_SHELL_PATH`，随后回退到服务进程 PATH，导致“全新设备测试”被当前开发机污染。

- `scripts/test-clean-device.mjs:11-45,104-111`
- `server/modules/leocodebox/cli-tools.routes.ts:177-203`

影响角色：新设备用户、发布工程师、所有 Agent CLI 用户。
修复要求：统一桌面壳传入的 CLI 搜索路径契约；测试必须完全隔离宿主机 PATH，并在无 CLI、单 CLI、多副本、nvm/fnm、Homebrew、standalone 六种环境运行。

### P1-2 正式包的浏览器能力开箱不可用，安装逻辑会改写已签名 App

正式安装包中“浏览器能力”已开启，但 Playwright、Chromium 均未安装；实际 MCP 创建会话返回 `Install Playwright and Chromium`。

更严重的是“安装运行环境”执行：

```text
npm install --no-save --no-package-lock playwright
npm exec playwright install chromium
```

工作目录是 `process.cwd()`。在正式版中该目录位于 `/Applications/leocodebox.app/Contents/Resources/app`，会直接修改已经 Developer ID 签名并公证的 App 内容，破坏代码签名封装，也无法保证其他账户具备写权限。

- `server/modules/browser-use/browser-use.service.ts:264-269,315-348`
- `src/components/settings/view/tabs/browser-use-settings/BrowserUseSettingsTab.tsx:151-173`

影响角色：浏览器 Agent 用户、新设备用户、安全与发布人员。
修复要求：Playwright 依赖随包提供，或安装到 `~/.leocodebox/runtime`；绝不能修改 `.app`。增加“挂载全新 DMG 后直接创建浏览器会话”的发布测试。

### P1-3 正式主分支 lint 失败

`npm run lint` 非零退出。Claude 与 Codex runtime 跨模块直接导入内部文件，违反项目边界规则：

- `server/modules/providers/list/claude/claude-runtime.ts:26`
- `server/modules/providers/list/codex/codex-runtime.ts:23`
- `server/modules/leocodebox/index.ts:1` 未从 barrel 导出该能力。

影响角色：开发、维护、CI/发布。
修复要求：通过 leocodebox 模块公开导出，并将 lint 设为发布硬门禁。

### P1-4 红色关闭按钮不会退出，也不会停止 38473 服务

当前窗口 `close` 事件被强制改为 `hide()`；只有 `Cmd+Q` 或菜单“退出”才进入服务停止流程。这与“关闭 App 就自动停服务”的产品要求冲突，也能解释用户认为 App 退出后又自己出现的体验。

- `electron/desktopWindow.js:754-765`
- `electron/main.js:554-574`

默认 `keepLocalServerRunning=false` 只对真正退出生效，不能解决红色关闭按钮语义。
修复要求：明确二选一：红色关闭即退出并停止服务；或首次关闭时让用户选择“退出/驻留”，且菜单栏和 Dock 必须清楚显示驻留状态。

### P1-5 Leoapi 备份恢复列表不可辨认，存在恢复错误配置风险

高级设置中多个备份只显示相同目标路径，例如多行 `~/.config/opencode/opencode.json`，没有创建时间、来源接口、原始版本或摘要。用户无法判断要恢复哪一份。

- `public/leocodebox-switch.html:1188-1197`
- `server/modules/leocodebox/provider-switch.routes.ts:548-577`

影响角色：Leoapi 重度用户、故障恢复用户。
修复要求：API 返回 `createdAt/size/provider/source`，界面按目标分组并显示时间；恢复前展示差异与明确的备份标识。

## 三、中风险与产品完整性问题

### P2-1 浏览器 MCP 令牌暴露在 Agent 进程命令行

Claude 进程的 `--mcp-config` 参数包含明文 `LEOCODEBOX_BROWSER_USE_MCP_TOKEN`，可通过本机进程列表读取。令牌可以调用本机浏览器控制 API。

- `server/modules/browser-use/browser-use.service.ts:478-493`

建议改为权限 `0600` 的临时凭据文件、短期令牌或 stdio 握手，不要把秘密放进 argv。

### P2-2 五个重复源文件被提交并打进正式 App

仓库存在 5 个带 ` 2.ts` 的完全相同副本；后端副本还被 TypeScript 编译为 `dist-server/**/* 2.js` 并进入安装包。正式 App 内已确认存在这些产物。

包括 `diagnostics.service 2.ts`、`codex-fallback.service 2.ts`、对应测试和 `useHandoffSource 2.ts`。

建议删除副本，并增加禁止 `* 2.*`、`copy`、`conflicted copy` 文件名的发布检查。

### P2-3 83 个视觉资产只有 7 处代码引用

`public/visuals` 有 83 个文件，但源码与公共页面仅检出 7 处引用；绝大多数生成资产没有进入真实工作流。当前视觉升级主要出现在 onboarding、少数空状态、About 和 Leoapi 空状态，日常高频界面提升有限。

建议先做资产清单与页面映射，保留真正提升信息层级的图片，删除未采用或低质量资产，避免资源堆积。

### P2-4 设置体系仍然分裂

顶栏“设置”只打开桌面主题；侧栏“设置”打开完整产品设置；Leoapi 内还有第三套设置。三个入口图标相近但作用域不同。Agent 横向标签在 1152px 窗口已截断 Grok Build。

建议顶栏设置进入统一设置中心，把“桌面外观”作为外观子项；Leoapi 仅保留接口相关设置。

### P2-5 普通浏览器入口仍显示账号密码页

Electron 桌面端确认免登录可用，但直接访问 `http://127.0.0.1:38473` 会落到登录页，未带本地令牌访问 API 返回 401。安全隔离本身合理，但桌面壳仍展示/复制本地 URL，容易让用户以为浏览器也能直接使用。

建议隐藏“复制本地 URL”，或提供一次性受控的“在浏览器打开”令牌链接，并明确安全边界。

### P2-6 API 文档仍大量使用旧端口 3001

`public/api-docs.html` 的示例仍写 `localhost:3001`，与正式端口 `38473` 不一致；`server/browser-use-mcp.ts` 的兜底值也仍为 3001。

### P2-7 旧 CloudCLI LaunchAgent 未迁移清理

本机仍存在 `~/Library/LaunchAgents/com.leoyuan.cloudcli.plist`，指向旧全局 CloudCLI 并占用同一端口 38473。当前 `RunAtLoad=false`，没有正在抢占，但旧用户迁移后仍有端口冲突和“旧产品复活”的风险。

建议首次启动检测旧 LaunchAgent，提示并安全停用；不能静默删除用户数据。

## 四、多角色体验结论

| 角色 | 结论 | 主要证据 |
|---|---|---|
| 新设备首次用户 | 不通过 | clean-device 失败；浏览器运行时缺失 |
| 新手 | 部分通过 | App 免登录、中文默认；三套设置入口仍混乱 |
| 熟练/重度用户 | 部分通过 | 会话、终端、文件、Git、统计均可见；设置与恢复信息不足 |
| Claude Code 用户 | 基本通过 | 识别 2.1.207；Leoapi 会话覆盖已接入；lint 边界失败 |
| Codex 用户 | 基本通过 | 识别 0.144.1、提示 0.144.3；缺失时可下载 fallback；同样有 lint 问题 |
| Gemini CLI 用户 | 基本通过 | 识别 0.50.0；版本更新链路未做真实升级破坏测试 |
| OpenCode 用户 | 基本通过 | 识别 1.17.18；真实历史会话正常显示 |
| Cursor/Hermes/Grok 用户 | 部分通过 | 三者均被识别且可执行，但注册表版本均显示“无法检查” |
| Leoapi 用户 | 部分通过 | 导入、模型读取、测试、测速、端点测试路由齐全；备份恢复不可辨认 |
| 浏览器 Agent 用户 | 不通过 | 正式包装态下运行时缺失，创建会话失败 |
| 安全/隐私 | 部分通过 | 本地 API 默认 401、诊断脱敏测试通过；MCP token 暴露于 argv |
| 发布/运维 | 不通过 | lint、clean-device 两个发布门禁失败；重复文件进入包 |
| UI/可访问性 | 部分通过 | 中文、浅色/深色/跟随系统具备；设置分裂、标签溢出、视觉资产利用率低 |

## 五、已验证通过

1. 已安装 App 为 `v1.40.4`，与 `origin/main` / tag 一致。
2. App 可直接进入历史会话，无账号登录墙。
3. 当前机器 7 个 CLI 均能从终端执行：Claude、Codex、Gemini、OpenCode、Cursor Agent、Hermes、Grok。
4. UI 正确展示 7 个 Agent 的当前版本；Codex 能提示新版本。
5. `npm run typecheck` 通过。
6. `npm run test` 通过：desktop 22、client 40、server 189，共 251 项。
7. `npm run build` 通过。
8. `npm audit --omit=dev` 为 0 个漏洞。
9. 新会话首条实时消息已有回归测试 `useChatSessionState.test.tsx`，测试通过；历史会话实际打开也能显示消息。
10. 正式 App 的 Developer ID、hardened runtime、公证票据、Gatekeeper 均通过；`spctl` 为 `accepted / Notarized Developer ID`。

## 六、建议修复顺序

1. 修复 clean-device 隔离、lint、重复文件，恢复发布门禁。
2. 重做浏览器运行时分发，禁止修改 `.app`，补正式 DMG 冷启动测试。
3. 修正关闭即退出/驻留语义，并处理旧 CloudCLI LaunchAgent 迁移。
4. 完善 Leoapi 备份元数据、差异预览和安全恢复。
5. 隐藏 argv 中的 MCP token，统一三套设置入口。
6. 清理 3001 文档、梳理视觉资产实际使用，再进行一轮真实全新 Mac 验收。

## 七、审计边界

未执行会消耗用户 API 额度的全 Agent 新对话，也未点击“更新 CLI”“安装浏览器运行环境”或“恢复备份”等有外部或破坏性副作用的操作。Agent 会话结论来自 CLI 可执行性、正式 UI 状态、已有历史会话、路由实现和自动测试；这些高副作用动作应在隔离 macOS 测试账户和临时 HOME 中完成。

截图证据位于 `docs/audit-1.40.4/screenshots/`。

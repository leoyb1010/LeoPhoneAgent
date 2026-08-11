# 会话交接记忆 · 2026-07-13（供新 session 继续升级）

> 上一会话完成了 1.40.0 蓝图全量落地 + 四个补丁版（1.40.1–1.40.4）。
> 本文档是完整工作记忆：现状、每版做了什么、架构关键坐标、发布流水线、坑、下一步。
> 仓库：`/Users/leoyuan/Documents/Codex/2026-07-09/chon/work/cloudcli-native-app`（main，工作区干净，全部已推送）

---

## 1. 当前状态（全部实测验证过）

- **当前版本：1.40.4**。/Applications 已安装并运行（health 实测），双 GitHub 仓 Release 已发，热更新 feed 指向 1.40.4，README 下载入口同步。
- 门禁基线：服务端 189 测试 + 前端 40 + 桌面 22 全绿；typecheck / eslint(0 warning) 干净。
- 本机 7 个 Agent CLI 全部最新且各副本版本一致（claude 2.1.207 ×3、codex 0.144.1、opencode 1.17.18、gemini 0.50.0、cursor 2026.06.26、hermes 0.18.2、grok 0.2.99）。
- 用户桌面有三份文档：Grok 版审计计划、我的《审计与升级蓝图-Claude》、《1.40.0发布后-下一步创新升级建议》。

## 2. 版本史（1.39.4 → 1.40.4，每版真实交付）

**1.40.0（蓝图全量落地，DMG 332MB→223MB）**
- 常驻秒开：服务保温复用（marker 带 token+版本，接管时采纳；版本不符杀旧起新）；关窗=藏窗进托盘；`keepLocalServerRunning` 设置生效（launcher 本地设置有开关，开启时 spawn 不传父进程 watchdog PID）
- 原地站回：last-session-id 持久化+启动直达；草稿本就按 projectId 持久化（审计误报，未改）
- 主进程解冻：login shell 探测异步化+缓存（userData/runtime-env-cache.json）
- 启动屏真实三阶段进度；空态 CLI 安装 CTA；节点徽标（状态栏消费 /switch/status）；Dock 角标+完成通知(>30s且未聚焦)；⌘K 换轨（useLeoapiSwitchSource）；Leoapi 三卡+端点昵称+测速条带+时间戳+Esc修复；搜索补 opencode（cursor 因二进制存储未做，UI 已标注覆盖范围）；跨 Agent Handoff（⌘K，可编辑前言）；死代码清除约1071行（LOCAL_ONLY 云路径+cloud.js+serverInstaller.js）；API Key 哈希落盘+封 ?apiKey= query+timingSafeEqual；诊断导出；codex 兜底二进制改按需下载（codex-fallback.service）；voice 设置项修复；About 署名
- ⚠️ utils.ts 拆分当时标记"完成"于任务列表但实际按蓝图"只拆会再改的域"处理——新 session 如要继续拆，先 grep 验证现状

**1.40.1（CLI 更新"假的"修复）**
- 根因：多副本（4 份 claude 三个版本并存），App 更新的副本≠用户终端运行的副本
- discoverCliCopies（which -a + realpath 去重 + 逐份测版本 + 来源分类）；状态/更新锚定 PATH 首位活动副本；npm 更新带 `--prefix=<副本前缀>` 定向；/opt/homebrew/bin 等原生安装识别为 standalone 走自更新；cursor `[unauthenticated]` 转人话；npm allow-scripts 拦截显式告知

**1.40.2（副本逻辑用户视角修正——用户亲自指出）**
- 副本发现改用 `LEOCODEBOX_LOGIN_SHELL_PATH`（Electron 捕获传入），服务进程增强 PATH 里的副本（其他 nvm 版本等）不再列出；不在用户 PATH 时回退全局探测
- 多副本提示只在用户 PATH 内版本不一致时显示

**1.40.3（Leoapi 四问题）**
- 编辑"已启用"接口 → 立即事务化重写配置 + 返回 reapplied/activeModel（此前只进存储，这是"改了不生效"主根因）
- 启用/重应用 → 聊天框模型自动重置（claude/codex/opencode 全覆盖；此前仅 opencode。聊天每条消息显式带 --model，不重置就永远发旧模型）
- 剪贴板：Electron 白名单补 `clipboard-sanitized-write`（desktopWindow.js configurePermissions）+ execCommand 兜底
- 模型选择：datalist → 自定义可滚动下拉（setModelOptions/renderModelDropdown/attachModelDropdown in leocodebox-switch.html）

**1.40.4（cc-switch 优先级 + 下拉回归）**
- 根因实锤：shell 导出的 ANTHROPIC_*（cc-switch 等留下）> 配置文件；本机实测抓到 `shellOverrides.claude.baseUrl=https://api.anthropic.com`
- 新增 `server/modules/leocodebox/provider-session-env.service.ts`：claude/codex 会话启动注入活动 Leoapi 接口 env 覆盖层（未启用则空，「本机原配置」语义不变）。注入点：claude-runtime.ts sdkOptions.env（mapCliOptionsToSDK 调用后合并）、codex-runtime.ts new Codex env
- /switch/status 暴露 shellOverrides，切换页 currentTargetMeta 警示终端/应用内优先级差异
- 下拉回归修复：聚焦显示全量（此前按已填值过滤显得"没有选项"），输入才过滤

## 3. 架构关键坐标（改过的热点）

- `electron/localServer.js`：保温/接管/adoptExistingServer/marker(含token)/keepLocalServerRunning/login-shell env 缓存/LEOCODEBOX_LOGIN_SHELL_PATH 传递
- `electron/main.js`：before-quit detach/shutdown 分支、window-all-closed 不退、isAppQuitting 传入窗口管理器
- `electron/desktopWindow.js`：close→hide（全屏先退）、权限白名单(:~675)、托盘
- `server/runtime/server-lifecycle.ts`：marker 写入（token、0600）、父进程 watchdog（keep-alive 时 Electron 不传 PID）
- `server/modules/leocodebox/cli-tools.routes.ts`：discoverCliCopies/classifyInstallSource/deriveNpmPrefixFromCopyPath/resolveCliUpdateCommand(activeCopy)
- `server/modules/leocodebox/provider-switch.routes.ts`：save 时 active 自动重应用(:185)、apply 返回 activeModel、status 含 shellOverrides
- `server/modules/leocodebox/provider-session-env.service.ts`：会话 env 覆盖层（新）
- `public/leocodebox-switch.html`：75KB vanilla 双UI；模型下拉机件；apply/save 后 `window.parent.dispatchEvent('leocodebox-provider:applied', {target, activeModel})`
- `src/components/chat/hooks/useChatProviderState.ts`：`leocodebox-provider:applied` 监听(:249)重置 claude/codex/opencode 模型 + bypassCache 刷新目录；模型存储键 `<provider>-model`
- `src/hooks/useProjectsState.ts`：原地站回三段 effect；`src/hooks/projectStateUtils.ts`：readLastSessionId/persistLastSessionId
- `src/components/settings/.../CliToolsSection.tsx`：copies 类型/多副本警示（版本不一致才显示）/notice 多行

## 4. 发布流水线（每次发版照抄）

```bash
npm version X.Y.Z --no-git-tag-version
# 写 docs/RELEASE-X.Y.Z.md（三段式：多了什么/更稳的/刻意没做的）→ commit
export LEOCODEBOX_SIGN_IDENTITY="Developer ID Application: leo yuan (48H5Y3LNUK)"
npm run desktop:dist:mac:signed
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy   # Clash 下公证必须
npm run desktop:notarize:mac        # submit --wait + staple + 重建 zip/yml
shasum -a 256 dmg/zip/yml → 回填 RELEASE 文档 + README(徽章/直链/SHA) → commit
git tag vX.Y.Z && git push origin main --tags
gh release create vX.Y.Z -R leoyb1010/leocodebox-updates --notes-file docs/RELEASE-X.Y.Z.md <dmg> <zip> <latest-mac.yml>
gh release create vX.Y.Z -R leoyb1010/leocodebox --notes-file ... <同三件>   # 源码仓也要发！用户会看这里
# 本地安装：quit → hdiutil attach → rm -rf /Applications/leocodebox.app → ditto → detach → open → curl /health 验版本
# 清理上一版 dmg/zip（release/desktop 只留最新）
```
验收：`stapler validate` + 副本加 quarantine 后 `spctl -a --type exec` = accepted/Notarized。

## 5. 坑与事实（省一小时系列）

- **公证在 Clash 代理下会断**：先 unset 全部代理变量再 notarize
- **源码仓（私有）和 updates 仓（公开）都要发 Release**，只推 tag 用户在源码仓 Releases 页看不到新版（踩过）
- 服务器复用的鉴权：marker `~/.leocodebox/local-server.json` 含 token（0600），新实例接管时采纳；测试可用 `LEOCODEBOX_SERVER_MARKER_PATH` 覆盖
- agent CLI 优先级：**进程 env > settings.json/auth.json**——一切"切换不生效"先查 env
- 检查运行中服务：pgrep `dist-server/server/index.js`；token 从 marker 读；用户手动退出应用后 marker 会消失（正常）
- npm allow-scripts 会拦 claude-code postinstall（App 已显式提示；放行命令见 1.40.1 notes）
- `块注释里写 ANTHROPIC_*/OPENAI_*` 的 `*/` 会终结注释（踩过）
- Bash 工具的 cwd 会被 skill 调用重置到 ~，每次先 cd 仓库
- 测试基线数字：server 189 / client 40 / desktop 22
- 已知未修小事：browser-use-mcp 子进程偶尔在退出后残留（观察到两次，未修，可考虑给 browser-use-mcp.ts 加父进程 watchdog）；cursor 自更新需其登录态（产品行为，已转人话提示）

## 6. 下一步（按桌面《创新升级建议》文档，1.41 候选）

优先级排序（价值/成本）：
1. **⌥Space 全局唤醒**（S，~30行 globalShortcut，保温已就位，全仓零 globalShortcut）
2. **更新可见性角标**（S，状态栏小圆点，desktopUpdater 状态推送现成）
3. **节点哨兵·确认式**（M，通知管线已通；只巡检当前节点 5-10min；连挂2次才建议；绝不自动切；默认关）
4. **测速历史 sparkline**（S，endpointStats 覆盖写改环形历史20条，SVG 手画）
5. **Handoff 回程票**（S，⌘K"回到交接来源"）
6. 工程收口：asar A/B（SIGNING.md 流程，223MB→预计~120MB）、长会话虚拟化(F-9)、Cursor 搜索接入（先画像）、UI 收口三件套、S-2 provider 密钥进 safeStorage
7. 冷冻池及解冻条件见桌面建议文档 §3；宪法：翻开关>接水管>写新码>开新面板；信任可见；确认式智能

## 7. 用户偏好（观察积累）

- 结论先行、精简直给、只报有证据的事实；发现问题会直说"问题很大"，要求真实生效而非表面完成
- 每次修复都要求：发布签名公证版 + 双仓上传 + 本地装最新只留一份 + 热更新可用
- 对"我们只看终端里那份"这类产品判断很准，先听用户的心智模型再设计
- Release notes 用三段式叙事模板；中文；commit 信息中文

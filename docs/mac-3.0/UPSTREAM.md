# ZCode 上游同步

- 当前上游:`29628c9a`(v3.14.3,2026-09-24 同步;上一次 `872ad960`,3.14.0)
- 引入方式:`git subtree add --prefix=src/mac/leophone https://github.com/zai-org/ZCode.git <sha> --squash`

## 同步
```bash
git -c core.hooksPath=/dev/null subtree pull --prefix=src/mac/leophone \
  https://github.com/zai-org/ZCode.git <新 sha> --squash
```
冲突只会出现在下面这几处(其余都是上游原样):

| 文件 | 我们改了什么 |
|---|---|
| `packages/desktop/scripts/desktop-product-identity.mjs` | 增加 `leo` 身份 |
| `packages/shared/src/env.ts` | `ZCODE_TELEMETRY_ENABLED = false` |
| `packages/desktop/src/main/autoUpdater.ts` | manifest 默认走 `LEO_UPDATE_MANIFEST_URL` |
| `packages/ui/src/Root.tsx` | 挂 `<LeoWhatsNew />` |
| `packages/ui/src/App.tsx`、`WindowsTopLeftLogo.tsx`、`components/ui/ZCodeAboutLogo.tsx` | 换标志 |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` | 文案里的产品名 |
| `packages/desktop/electron-builder.config.js` | extraResources 带上 `leo/` |
| `packages/desktop/src/host/index.ts` | 启动 Leo 层 |
| 根 `package.json` | 版本号与 `leo:*` 脚本 |
| `packages/shared/src/zcodeEndpoint.ts` | 官方 endpoint / BigModel / Z.ai OAuth / 业务 API 默认值全部指向 `http://127.0.0.1:9`,不内置官方 OAuth client id |
| `packages/shared/src/plugin-marketplaces.ts` | 官方市场远端分片指向死端口,只保留随包插件 |
| `packages/shared/package.json` | 导出 `./leo-network-guard` |
| `packages/desktop/src/main/index.ts`、`src/host/index.ts`、`src/scheduler/index.ts` | 第一行 import 网络兜底;main 在 ready 时装 session 拦截、导出 `ZCODE_HOME=~/.leophoneagent` |
| `packages/desktop/src/main/forceUpdateGuard.ts` | 官方远程强制升级直接放行 |
| `packages/desktop/src/main/remoteCdn.ts` | 不再默认官方 CDN(远程工作区运行时暂不可用) |
| `packages/desktop/src/main/{desktopDataBaseDirBootstrap,desktopRuntimeEnv,desktopCommandHandlers,exportLogs}.ts`、`index.ts` 的 settingsFile | `~/.zcode` → `~/.leophoneagent` |
| `packages/desktop/src/main/{desktopOAuthDeepLink,desktopDeepLinkUrl,desktopFinderOpenFolderWorkflow}.ts` | URL scheme `zcode` → `leophoneagent` |
| `packages/desktop/electron-builder.config.js` | scheme、版权行、updater 缓存目录名、随包 ZCode LICENSE/NOTICE、嵌套二进制补签 |
| `packages/services/src/oauth/runtimeConfig.ts` | 官方 OAuth provider 列表置空 |
| `packages/services/src/conversation-share/conversationShareService.ts` | 分享 / 导入入口直接拒绝 |
| `packages/services/src/{subagents/subagentStorage,subagents/subagentsService,plugin-sync/pluginSyncService,runtime-tools/providerRuntimeResolver}.ts` | 用户级 `~/.zcode` → `~/.leophoneagent` |
| `packages/services/src/{paths,node}.ts` | 数据根 `~/.leophoneagent` |
| `packages/ui/src/WelcomeScreen.tsx` | 去掉官方登录入口,加「用订阅账号登录」 |
| `packages/services/src/{coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider,client-config/clientConfigService,client-scenes/clientScenesService}.ts` | 官方 client/configs、client/scenes 本地给空配置,不发请求(闲时任务关、强制升级无、灰度走本地默认) |
| `packages/shared/src/dynamic-workflow-feature.ts` | 动态工作流本地默认 `onDemand` |
| `packages/services/src/**` 其余用户级路径(settings、settings-sync、skills、commands、hooks、mcp-sync、skill-sync、device、telemetry、storage roots、agent 日志/轨迹/插件管理目录) | `~/.zcode` → `~/.leophoneagent`;工作区级 `<项目>/.zcode/*` 不动 |
| `packages/shared/src/zcode-agent-runtime.ts` | `nativeConfigDir` → `.leophoneagent/cli` |
| `packages/desktop/src/main/mcpUserDirectory/*` | MCP 用户目录 → `~/.leophoneagent/cli` |
| `packages/desktop/src/main/{desktopApplicationMenu,desktopCommandHandlers}.ts` | 去掉「反馈」菜单;「更新日志」打开 leocodebox-updates 发布页 |
| `apps/zcode-cli/**`(约 35 个文件) | 官方 OAuth / 换 Key / 官方网关改写 / 远程供应商目录 / 官方市场 / 官方 MCP 信任 / 遥测全部切断;用户级数据根 `~/.leophoneagent`;`packages/cli/src/main.ts` 第一行 import 网络兜底 |
| `packages/ui/src/**`(约 34 个文件) | 账号头像与套餐、升级、反馈、分享、官方文档/社区、智谱模板、CDN 图标与官方插件入口移除;设置 → 模型供应商加订阅登录按钮;Root 在欢迎页后按请求打开模型设置 |
| `apps/zcode-cli/packages/contracts/src/tools/{index,edit,read}.ts` | 导出 `leo-edit.js`;`EditOutput` 加可选 `leo` 摘要(段数 / 匹配策略 / hashline 预览);`ReadTextOutput` 加可选 `lineFormat` |
| `apps/zcode-cli/packages/core/src/index.ts` | 导出 `tool/leo/index.js`(Leo agent 档位 API) |
| `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts` | 入参走 `LeoEditInputSchema`(单段 / `edits[]` / hashline 锚点 / 参数修复);多段与锚点交 `leo/edit-plan`;BOM 剥离后匹配再拼回;按文件写队列;匹配策略计数;hashline 模式结果附新锚点 |
| `apps/zcode-cli/packages/core/src/tool/handlers/write.ts` | handler 套按文件写队列 |
| `apps/zcode-cli/packages/core/src/tool/edit-matchers.ts` | exact 之后插入 `hashline_prefix_stripped` / `unicode_normalized` 两级窄匹配 |
| `apps/zcode-cli/packages/core/src/tool/handlers/{read,read-text}.ts` | 文本读取按模型走 hashline / 无行号窗口(2000 行 / 50KB);窗口按 range view 记 read-state;hashline 模式编辑后重读不回“未变”占位 |
| `apps/zcode-cli/packages/core/src/tool/handlers/index.ts` | 注册选项加 `leoAgent`;Edit / Read 用 `withLeoModelProfile` 包装 |
| `apps/zcode-cli/packages/core/src/tool/provider-visible-order.ts` | 非内置工具按名排序、码点比较(prompt cache 稳定) |
| `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts` | `tool.call.completed` 日志加 `editMatchStrategies` |
| `apps/zcode-cli/packages/core/src/runtime/{types,helpers/runtime-tools,methods/embedded-search-branch,methods/subagent}.ts` | `AgentRuntimeConfig.leoAgent` 及其透传 |
| `apps/zcode-cli/packages/core/src/runtime/{helpers/tool-allowlist,methods/mcp,methods/context}.ts` | 精简档:核心工具白名单、不注册 MCP、最小系统提示词 |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts` | 记本步输出预算;过早 length 截断先压缩重试;超窗 / 丢弃的尝试收尾并对 provider 隐藏 |
| `apps/zcode-cli/packages/core/src/runtime/{methods/message-persistence,internal-turn-methods}.ts`、`agent/session-history-hydrator.ts` | assistant 消息可标 `providerVisibility: "hidden"`,冷恢复跳过 |
| `apps/zcode-cli/packages/adapters/src/model/model-execution.ts` | OpenAI 系 fetch 套 `prompt_cache_key`;openai-compatible 用 `convertLeoOpenAICompatibleUsage` |
| `apps/zcode-cli/packages/bootstrap/src/app/{runtime-config,create-app}.ts` | 读 `leo` 档位进 `runtimeConfig.leoAgent`;非法字段记 warning;model adapter env 注入合并后的 `ZCODE_LEO_AGENT` |

新增文件(零冲突):`packages/ui/src/leo/`、`packages/desktop/src/host/leo/`、
`packages/desktop/leo/`、`packages/desktop/src/main/{leoUpdateFeed,leoSessionGuard,leoEarlyEnv,leoLinkIpc}.ts`、
`packages/desktop/src/preload/leoBridge.ts`、
`packages/shared/src/leoNetworkGuard.ts`、`scripts/leo-*`。

**独立性红线(同步上游后逐条复查)**:不连任何 `*.z.ai / bigmodel.cn / zhipuai.cn / zcode.ai`;
不读 `~/.zcode`;不接官方账号;更新只走 `leocodebox-updates`。上游新增的联网点,
网络兜底会拦下并在日志里留下「属于官方服务,LeoPhoneAgent 不连接」,按日志补源头。

已删除的上游文件(同步时若上游改了它们,按删除处理):`packages/ui/src/login/LoginApiKeyForm.tsx`、
`packages/ui/src/login/LoginApiKeyForm.helpers.ts`、`packages/ui/src/onboarding/assets/feishu.png`。

同步后必须跑:typecheck、lint、architecture:check、`leo:bundle:mac` 冒烟。

## v3.14.3 同步记录(2026-09-24,Mac 1.1.0)
- 上游 283 个文件:87 个新增、176 个原样取上游、17 个自动三方合并、3 个冲突(根 `package.json` 取我们的;`contracts/src/tools/save-workflow.ts` 取上游,新文案已不含 `~/.zcode`;`packages/ui/src/WorkspaceSidebarFooter.tsx` 手工合:保留我们删掉用量摘要后的 import,补上游的 `WorkspaceWebRemoteControlTrigger`,并恢复 `workspacePath`/`workspaceIdentity` 两个解构参数)。
- 新增补丁,下次同步要复查:
  - `packages/services/src/bots/{messages,feishuChannelRuntime,telegramChannelRuntime,weixinChannelRuntime}.ts`:回复与提示里的 ZCode 改成 LeoPhoneAgent。
  - `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`:新增的机器人文案里的 ZCode 改名(14 行)。
  - `packages/desktop/electron-builder.config.js`:`extraMetadata.homepage/author` 与 `linux.maintainer` 不再写官方网址和邮箱。
  - 根 `package.json` 的 `leo:bundle:mac`:固定打开签名(`ZCODE_ENABLE_MAC_SIGN=1`,默认身份 `leo yuan (48H5Y3LNUK)`),不签名就打不出包。
- 上游 3.14.3 把机器人任务硬锁成 yolo(`services/src/bots/botsService.ts` 的 `BOT_FORCED_MODE`),M1b 会改成 build 并加工具规则,到时记在这里。

## Mac 1.2.0 补丁(2026-09-25,M1b)
- `packages/services/src/bots/botsService.ts` 两处,同步时必须保留(`services/test/leoBotPolicy.test.ts` 会拦):
  - `const BOT_FORCED_MODE = LEO_BOT_FORCED_MODE;` —— 机器人任务改为 build,不再免审批。
  - 权限卡片的选项先过 `filterBotPermissionOptions(event, context.workspacePath)`:聊天里只能批只读工具与工作区内改文件,其余只能拒绝,不给项目级「总是允许」。三处 `respondPermission` 都只认这里留下的选项。
  - 规则本体在我们自己的 `packages/services/src/bots/leoBotPolicy.ts`。
- `packages/desktop/src/host/leo/link/` 整个目录是我们的(手机桥接 Leo Link),不涉及上游文件。
- 自建的 `packages/desktop/src/host/leo/telegram.ts` 已删除,Telegram 改走上游机器人。

## Mac 1.2.1 补丁(2026-09-25)
- `apps/zcode-cli/packages/core/src/permission/service.ts` 的 `checkAlwaysAsk`:在硬禁用、auto 保护、项目 deny 之后,
  yolo(界面叫「完全访问」)且非 plan 时直接放行 alwaysAsk 工具(工作流的创建 / 保存 / 修改)。上游在 yolo 下仍会问;
  同步时保留这一段(标了 `[leo]`)。

## Mac 1.3.0 补丁(2026-09-26,界面换皮 + 扫码连手机)
- 皮肤层全在 `packages/ui/src/leo/skin/`(变量覆盖 + 稳定钩子),由 `leo/LeoWhatsNew.tsx` 引入;不改 `styles.css` 令牌块和 `components/ui/*`。
  依赖的上游钩子:`.chat-composer-input-surface form > .rounded-2xl`(输入卡)、`[data-testid="v4-stop"]`(在跑)、
  `[data-testid="v4-composer-send"]`、`.theme-zai-{dark,light}`。同步后这几个选择器若失效,皮肤只是退回上游外观,不会坏功能。
- 上游文件(都标了 `[leo]`):
  - `packages/ui/src/v4/ConversationDraftEmptyState.tsx`:去掉大号线框水印,问候上方放实心 `LeoMark`。
  - `packages/ui/src/v4/SessionPane.tsx`:草稿页输入框下方挂 `LeoDraftStatusList`(等你确认 / 在跑 / 做完待看)。
  - `packages/ui/src/App.tsx`:最外层包 `LeoHomeProvider`(已打开项目 + 打开任务)。
  - `packages/ui/src/WelcomeScreen.tsx`、`onboarding/OnboardingWelcomeView.tsx`:图标不再外套深色方块。
  - `packages/ui/src/WebRemoteControlDialog.tsx`:最前面挂 `LeoPhoneLinkSection`(连接状态 + 扫码加手机)。
  - `packages/desktop/src/renderer/index.html`:启动标志改为安静浮现,不回弹。
  - `packages/ui/src/openWorkspacePageThemeHero.tsx`:两套 Zai 主题的欢迎背景从智谱蓝换成暖色 + 青绿。
  - `packages/ui/src/PermissionDialog.tsx`:根节点加 `data-leo-approval`,皮肤层据此做审批卡滑入。
  - `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`:`webRemoteControl.description` 改成「手机 App 或聊天机器人」。
  - `packages/desktop/src/main/index.ts`:ready 时 `registerLeoLinkIpc()`。
  - `packages/desktop/src/preload/index.ts`:引入 `./leoBridge.js`(暴露 `window.leoLink`)。

## Agent 编码能力补丁(2026-09-26)
- 上游文件改动见上表 `apps/zcode-cli/...` 各行,改动处都标了 `[leo]`。`pnpm leo:test:agent` 里的
  `core/test/leo/runtime-hooks.test.ts` 会检查这些钩子还在,同步上游把它们冲掉时会红。
- 新增文件(零冲突):`contracts/src/tools/leo-edit.ts`、`core/src/tool/leo/`、`core/src/runtime/leo/`、
  `adapters/src/model/leo-prompt-cache.ts`、`bootstrap/src/app/leo-agent-config.ts`、`*/test/leo/`(以上都在 `apps/zcode-cli/packages/` 下)、
  `scripts/leo-eval/`(eval 工具,见其 README);根 `package.json` 加 `leo:test:agent`、`leo:eval`。
- 配置:`~/.leophoneagent/cli/config.json`(或项目 `zcode.json` / `.zcode/config.json`)的 `"leo"` 段,环境变量 `ZCODE_LEO_AGENT`(同结构 JSON)优先:
  `{"editMode":{"default":"replace","models":{"*glm*":"hashline"}},"readLineNumbers":{"default":true,"models":{}},"leanProfile":false,"promptCacheKey":true}`。
  内置默认:所有模型都走 replace(`"hashlineFamilies": true` 才让 GLM / Kimi / MiniMax 走 hashline,评测台在真实模型上跑出提升再考虑默认打开);行号默认保留;精简档默认关;`prompt_cache_key` 默认只发给 api.openai.com / openrouter.ai。
